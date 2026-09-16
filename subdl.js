const axios = require('axios');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildSubDLStremConfig(apiKey) {
  const defaultPath = 'ZnptR0ozSjBGdDFXS003T1UyTHQ2bnhfLWx1b2FkNUwvQVIvaGlJbmNsdWRlLw';
  const key = (apiKey || process.env.SUBDL_API_KEY || '').trim();

  if (!key) return defaultPath;

  if (key.length > 40 && !key.includes(' ') && !key.startsWith('fz')) {
    return key;
  }

  try {
    const rawConfig = `${key}/AR/hiInclude/`;
    return Buffer.from(rawConfig).toString('base64').replace(/=/g, '');
  } catch (e) {
    return defaultPath;
  }
}

async function fetchSubDLStremTop(imdbId, season, episode, type, apiKey) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const configPath = buildSubDLStremConfig(apiKey);
    const isSeries = type === 'series' || !!season;
    const endpointType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

    const requestUrl = `https://subdl.strem.top/${configPath}/subtitles/${endpointType}/${targetId}.json`;

    const res = await axios.get(requestUrl, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'application/json'
      },
      timeout: 9000
    });

    const list = res.data?.subtitles || [];
    if (!Array.isArray(list)) return [];

    return list.map(item => {
      const langRaw = (item.lang || 'ara').toLowerCase();
      const isArabic = langRaw.startsWith('ar') || langRaw === 'ara';

      return {
        url: item.url,
        lang: isArabic ? 'ara' : 'eng',
        origName: item.id || 'SubDL',
        _source: 'subdl',
        _isZip: false,
        _priority: isArabic ? 1 : 2
      };
    }).filter(s => s.url);
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
      _source: 'subdl',
      _isZip: false,
      _priority: 2
    }));
  } catch (e) {
    return [];
  }
}

async function getSubDL({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const requests = [
    fetchSubDLStremTop(imdbId, season, episode, type, apiKey),
    fetchSubDLMirror(imdbId, season, episode, type)
  ];

  const results = await Promise.allSettled(requests);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getSubDL };
