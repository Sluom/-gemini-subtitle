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
    timeout: 7000
  };
}

function cleanTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\(\d{4}\)/g, '')
    .replace(/[^\w\s\u0600-\u06FF]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMatchingEpisode(text, season, episode) {
  if (episode === null || episode === undefined) return true;
  const ep = parseInt(episode, 10);
  const s = season ? parseInt(season, 10) : 1;
  const pattern = new RegExp(`(?:s0*${s}[._ -]*e0*${ep}|${s}x0*${ep}|(?:^|[^a-z0-9])(?:e|ep|episode)[._ -]*0*${ep}(?:[^a-z0-9]|$)|(?:\\[|\\(|-|\\s)0*${ep}(?:\\]|\\)|-|\\s|$))`, 'i');
  return pattern.test(text);
}

async function findMovieId(imdbId, title, apiKey) {
  const headers = { 'X-API-Key': apiKey.trim() };

  if (imdbId && imdbId.startsWith('tt')) {
    try {
      const r = await axios.get(`https://api.subsource.net/api/v1/movies/search?query=${encodeURIComponent(imdbId)}`, getAxiosConfig(headers));
      const list = r.data?.data || r.data?.movies || [];
      if (list.length > 0) {
        return list[0].movieId || list[0].id;
      }
    } catch (e) {}
  }

  const query = cleanTitle(title);
  if (!query) return null;

  try {
    const r = await axios.get(`https://api.subsource.net/api/v1/movies/search?query=${encodeURIComponent(query)}`, getAxiosConfig(headers));
    const list = r.data?.data || r.data?.movies || [];
    if (list.length > 0) {
      return list[0].movieId || list[0].id;
    }
  } catch (e) {}

  return null;
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }) {
  if (!apiKey) return [];

  try {
    const movieId = await findMovieId(imdbId, title, apiKey);
    if (!movieId) return [];

    const headers = { 'X-API-Key': apiKey.trim() };
    const r = await axios.get(
      `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}&language=arabic&sort=newest&limit=30`,
      getAxiosConfig(headers)
    );

    let list = r.data?.data || r.data?.subtitles || [];
    if (!Array.isArray(list) || list.length === 0) return [];

    if (season || episode) {
      const filtered = list.filter(item => {
        const info = Array.isArray(item.releaseInfo) ? item.releaseInfo.join(' ') : (item.releaseInfo || '');
        const comment = item.comment || '';
        return isMatchingEpisode(`${info} ${comment}`, season, episode);
      });
      if (filtered.length > 0) list = filtered;
    }

    return list.slice(0, 10).map(s => {
      const subId = s.subtitleId || s.id;
      const release = Array.isArray(s.releaseInfo) ? s.releaseInfo.join(' ') : (s.releaseInfo || 'SubSource');
      const format = (s.format || 'srt').toLowerCase();
      return {
        url: `subsource://${subId}.${format}?apiKey=${encodeURIComponent(apiKey.trim())}`,
        lang: 'ara',
        origName: release,
        _source: 'subsource',
        _priority: 2,
        _ext: format
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchSubSourceBuffer(customUrl) {
  const match = customUrl.match(/^subsource:\/\/([^.?]+)(?:\.([^?]+))?(?:\?apiKey=(.+))?$/);
  if (!match) throw new Error('Invalid SubSource URL');

  const subId = match[1];
  const apiKey = decodeURIComponent(match[3] || '');
  if (!apiKey) throw new Error('Missing API Key');

  const dl = await axios.get(
    `https://api.subsource.net/api/v1/subtitles/${subId}/download`,
    getAxiosConfig({ 'X-API-Key': apiKey.trim() })
  );

  const directLink = dl.data?.data?.downloadUrl || dl.data?.data?.link || dl.data?.downloadUrl || dl.data?.link;
  if (!directLink) throw new Error('No download link found');

  const fileRes = await axios.get(directLink, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: { 'User-Agent': getRandomUA(), 'Accept': '*/*' }
  });

  return Buffer.from(fileRes.data);
}

module.exports = { getSubSource, fetchSubSourceBuffer };
