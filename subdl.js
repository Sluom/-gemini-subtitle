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
    timeout: 10000
  };
}

async function fetchSubDLv2(params, apiKey) {
  if (!apiKey) return [];
  try {
    const qs = new URLSearchParams({ ...params, languages: 'ar,en', unpack: '1' });
    const r = await axios.get(`https://api.subdl.com/api/v2/subtitles/search?${qs.toString()}`, getAxiosConfig({ Authorization: `Bearer ${apiKey.trim()}` }));
    const subs = r.data?.subtitles || r.data?.results || [];
    return subs.filter(s => s && (s.url || s.download_url || s.file_url)).map(s => ({
      url: s.url || s.download_url || s.file_url,
      lang: (s.lang || s.language || 'ara').toLowerCase(),
      origName: s.release_name || s.name || 'SubDL',
      _source: 'subdl-v2',
      _priority: 2
    }));
  } catch (e) {
    return [];
  }
}

async function fetchSubDLDirectZip(imdbId, season, episode, apiKey) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ api_key: apiKey.trim(), imdb_id: imdbId, languages: 'AR,EN' });
    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, getAxiosConfig());
    return (r.data?.subtitles || []).filter(item => item.url).map(item => ({
      url: item.url.startsWith('http') ? item.url : `https://dl.subdl.com${item.url}`,
      lang: (item.lang || 'ara').toLowerCase(),
      origName: item.release_name || item.name || 'SubDL Archive',
      _source: 'subdl-official',
      _isZip: true,
      _priority: 99
    }));
  } catch (e) {
    return [];
  }
}

async function fetchSubDLMirror(targetId, type) {
  try {
    const r = await axios.get(`https://subdl-stremio.vercel.app/subtitles/${type}/${targetId}.json`, getAxiosConfig());
    return (r.data?.subtitles || []).map(s => ({
      url: s.url,
      lang: s.lang || 'ara',
      origName: s.title || s.name || 'SubDL Mirror',
      _source: 'subdl-mirror',
      _priority: 2
    }));
  } catch (e) {
    return [];
  }
}

async function getSubDL({ imdbId, season, episode, type, targetId, apiKey }) {
  const requests = [];

  requests.push(fetchSubDLMirror(targetId, type));

  if (apiKey && imdbId && imdbId.startsWith('tt')) {
    requests.push(fetchSubDLv2({ imdb_id: imdbId, season, episode }, apiKey));
    requests.push(fetchSubDLDirectZip(imdbId, season, episode, apiKey));
  }

  const results = await Promise.allSettled(requests);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getSubDL };

