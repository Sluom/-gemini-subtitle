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

async function getSubSource({ title, imdbId, apiKey }) {
  if (!apiKey) return [];
  const query = title || imdbId;
  if (!query) return [];

  try {
    const search = await axios.get(
      `https://api.subsource.net/api/v1/movies/search?query=${encodeURIComponent(query)}`,
      getAxiosConfig({ 'X-API-Key': apiKey.trim() })
    );

    const movieId = search.data?.data?.[0]?.movieId || search.data?.movies?.[0]?.id;
    if (!movieId) return [];

    const subsRes = await axios.get(
      `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}&language=arabic&sort=newest&limit=20`,
      getAxiosConfig({ 'X-API-Key': apiKey.trim() })
    );

    const subs = subsRes.data?.data || [];
    const results = [];

    for (const s of subs.slice(0, 10)) {
      try {
        const dl = await axios.get(
          `https://api.subsource.net/api/v1/subtitles/${s.subtitleId}/download`,
          getAxiosConfig({ 'X-API-Key': apiKey.trim() })
        );

        const link = dl.data?.link || dl.data?.url || dl.data?.downloadUrl;
        if (link) {
          results.push({
            url: link,
            lang: 'ara',
            origName: Array.isArray(s.releaseInfo) ? s.releaseInfo.join(' ') : (s.releaseInfo || 'SubSource'),
            _source: 'subsource',
            _priority: 2
          });
        }
      } catch (e) {}
    }

    return results;
  } catch (err) {
    return [];
  }
}

module.exports = { getSubSource };
