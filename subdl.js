const axios = require('axios');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getAxiosConfig(apiKey) {
  const headers = {
    'User-Agent': getRandomUA(),
    'Accept': 'application/json'
  };

  if (apiKey) {
    const cleanKey = apiKey.trim();
    headers['Authorization'] = `Bearer ${cleanKey}`;
    headers['X-API-Key'] = cleanKey;
  }

  return {
    headers,
    timeout: 8500
  };
}

async function fetchSubDLApi(imdbId, season, episode, type, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];
  const cleanKey = apiKey.trim();

  try {
    const params = new URLSearchParams({
      api_key: cleanKey,
      imdb_id: imdbId,
      languages: 'AR,EN',
      subs_per_page: '30',
      unpack: '1'
    });

    if (type === 'series' || season) {
      params.set('type', 'tv');
    } else {
      params.set('type', 'movie');
    }

    if (season) params.set('season_number', String(season));
    if (episode) params.set('episode_number', String(episode));

    const url = `https://api.subdl.com/api/v1/subtitles?${params.toString()}`;
    const res = await axios.get(url, getAxiosConfig(cleanKey));

    if (!res.data || res.data.status === false) return [];

    const subtitles = res.data.subtitles || [];
    const results = [];

    for (const item of subtitles) {
      const releaseName = item.release_name || item.name || 'SubDL';
      const langRaw = (item.lang || item.language || 'AR').toLowerCase();
      const isArabic = langRaw.includes('ar') || langRaw.includes('عرب');
      const lang = isArabic ? 'ara' : 'eng';

      if (Array.isArray(item.unpack_files) && item.unpack_files.length > 0) {
        for (const file of item.unpack_files) {
          if (!file.url) continue;
          const fullFileUrl = file.url.startsWith('http')
            ? file.url
            : `https://dl.subdl.com${file.url.startsWith('/') ? '' : '/'}${file.url}`;

          const fileLangRaw = (file.language || item.lang || 'AR').toLowerCase();
          const fileIsAr = fileLangRaw.includes('ar') || fileLangRaw.includes('عرب');

          if (episode && file.episode && parseInt(file.episode, 10) !== parseInt(episode, 10)) {
            continue;
          }

          results.push({
            url: fullFileUrl,
            lang: fileIsAr ? 'ara' : 'eng',
            origName: file.release_name || file.name || releaseName,
            _source: 'subdl-api',
            _isZip: false,
            _priority: 2
          });
        }
      }

      if (item.url) {
        const fullUrl = item.url.startsWith('http')
          ? item.url
          : `https://dl.subdl.com${item.url.startsWith('/') ? '' : '/'}${item.url}`;

        const isZip = fullUrl.toLowerCase().endsWith('.zip') || (item.name && item.name.toLowerCase().endsWith('.zip'));

        results.push({
          url: fullUrl,
          lang: lang,
          origName: releaseName,
          _source: 'subdl-api',
          _isZip: isZip,
          _episode: episode || 1,
          _priority: isZip ? 3 : 2
        });
      }
    }

    return results;
  } catch (err) {
    return [];
  }
}

async function fetchSubDLMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const mediaType = season ? 'series' : (type === 'series' ? 'series' : 'movie');
    const mirrorTargetId = season ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    const r = await axios.get(
      `https://subdl-stremio.vercel.app/subtitles/${mediaType}/${mirrorTargetId}.json`,
      {
        headers: { 'User-Agent': getRandomUA() },
        timeout: 5000
      }
    );

    return (r.data?.subtitles || []).map(s => ({
      url: s.url,
      lang: (s.lang || 'ara').toLowerCase().startsWith('ar') ? 'ara' : 'eng',
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

  if (apiKey && apiKey.trim()) {
    requests.push(fetchSubDLApi(imdbId, season, episode, type, apiKey));
  }

  const results = await Promise.allSettled(requests);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getSubDL };
