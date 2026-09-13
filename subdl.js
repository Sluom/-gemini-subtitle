const axios = require('axios');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getAxiosConfig(extraHeaders = {}) {
  return {
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': '*/*',
      ...extraHeaders
    },
    timeout: 8000
  };
}

async function fetchSubDLv2(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const params = new URLSearchParams({
      api_key: apiKey.trim(),
      imdb_id: imdbId,
      languages: 'ar,en',
      unpack: '1'
    });
    if (season) params.set('season_number', String(season));
    if (episode) params.set('episode_number', String(episode));

    const r = await axios.get(`https://api.subdl.com/api/v2/subtitles/search?${params.toString()}`, getAxiosConfig());
    const subs = r.data?.subtitles || r.data?.results || [];
    return subs
      .filter(s => s && (s.url || s.download_url || s.file_url))
      .map(s => {
        const downloadUrl = s.url || s.download_url || s.file_url;
        const fullUrl = downloadUrl.startsWith('http') ? downloadUrl : `https://dl.subdl.com${downloadUrl}`;
        return {
          url: fullUrl,
          lang: (s.lang || s.language || 'ara').toLowerCase(),
          origName: s.release_name || s.name || 'SubDL',
          _source: 'subdl-v2',
          _priority: 2
        };
      });
  } catch (e) {
    return [];
  }
}

async function fetchSubDLSeasonPacks(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const params = new URLSearchParams({
      api_key: apiKey.trim(),
      imdb_id: imdbId,
      languages: 'AR,EN'
    });
    if (season) params.set('season_number', String(season));

    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, getAxiosConfig());
    const subs = r.data?.subtitles || [];
    return subs
      .filter(item => item && item.url)
      .map(item => {
        const fullUrl = item.url.startsWith('http') ? item.url : `https://dl.subdl.com${item.url}`;
        return {
          url: fullUrl,
          lang: (item.lang || 'ara').toLowerCase(),
          origName: item.release_name || item.name || 'SubDL Season Pack',
          _source: 'subdl-official',
          _isZip: true,
          _episode: episode,
          _priority: 3
        };
      });
  } catch (e) {
    return [];
  }
}

async function fetchSubDLMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const mediaType = season ? 'series' : (type === 'series' ? 'series' : 'movie');
    const mirrorTargetId = season ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    const r = await axios.get(`https://subdl-stremio.vercel.app/subtitles/${mediaType}/${mirrorTargetId}.json`, getAxiosConfig());
    return (r.data?.subtitles || []).map(s => ({
      url: s.url,
      lang: (s.lang || 'ara').toLowerCase(),
      origName: s.title || s.name || 'SubDL Mirror',
      _source: 'subdl-mirror',
      _priority: 2
    }));
  } catch (e) {
    return [];
  }
}

async function getSubDL({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const requests = [
    fetchSubDLMirror(imdbId, season, episode, type)
  ];

  if (apiKey) {
    requests.push(fetchSubDLv2(imdbId, season, episode, apiKey));
    requests.push(fetchSubDLSeasonPacks(imdbId, season, episode, apiKey));
  }

  const results = await Promise.allSettled(requests);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getSubDL };
