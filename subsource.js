const axios = require('axios');

function getHeaders(apiKey) {
  return {
    'X-API-Key': apiKey ? apiKey.trim() : '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
}

async function getSubSource({ title, imdbId, season, episode, apiKey }) {
  if (!apiKey) return [];

  try {
    let searchUrl = '';
    if (imdbId && imdbId.startsWith('tt')) {
      searchUrl = `https://api.subsource.net/api/v1/movies/search?query=${imdbId}&searchType=imdb`;
    } else if (title) {
      searchUrl = `https://api.subsource.net/api/v1/movies/search?query=${encodeURIComponent(title)}&searchType=text`;
    } else {
      return [];
    }

    const searchRes = await axios.get(searchUrl, { 
      headers: getHeaders(apiKey), 
      timeout: 7000 
    });

    const movies = searchRes.data?.data || searchRes.data?.movies || [];
    if (!movies.length) return [];

    const movie = movies[0];
    const movieSlug = movie.slug || movie.id;
    if (!movieSlug) return [];

    const subsUrl = `https://api.subsource.net/api/v1/movies/${movieSlug}/subtitles?langs=Arabic,English`;
    const subsRes = await axios.get(subsUrl, { 
      headers: getHeaders(apiKey), 
      timeout: 7000 
    });

    let list = subsRes.data?.data || subsRes.data?.subtitles || [];
    if (!Array.isArray(list)) return [];

    if (season && episode) {
      const sNum = parseInt(season, 10);
      const eNum = parseInt(episode, 10);
      const epRegex = new RegExp(`(?:s0*${sNum}[._ -]*)?(?:e|ep|episode)[._ -]*0*${eNum}(?:[^0-9]|$)`, 'i');

      const filtered = list.filter(item => {
        if (item.season && item.episode) {
          return parseInt(item.season, 10) === sNum && parseInt(item.episode, 10) === eNum;
        }
        const name = item.release_name || item.name || '';
        return epRegex.test(name);
      });

      if (filtered.length > 0) {
        list = filtered;
      }
    }

    return list.map(item => {
      const subId = item.id || item.subId || item.link;
      const langRaw = (item.lang || item.language || '').toLowerCase();
      const isArabic = langRaw.includes('ar') || langRaw.includes('عرب');
      const releaseName = item.release_name || item.name || 'SubSource';
      const isAss = releaseName.toLowerCase().endsWith('.ass');

      return {
        url: `subsource://${movieSlug}/${subId}?key=${encodeURIComponent(apiKey)}&ext=${isAss ? 'ass' : 'srt'}`,
        lang: isArabic ? 'ara' : 'eng',
        origName: releaseName,
        _source: 'subsource',
        _priority: 2
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchSubSourceBuffer(subsourceCustomUrl) {
  try {
    const raw = subsourceCustomUrl.replace('subsource://', 'http://dummy/');
    const parsed = new URL(raw);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const movieSlug = parts[0];
    const subId = parts[1];
    const apiKey = parsed.searchParams.get('key') || '';

    if (!subId) return Buffer.from('');

    const headers = getHeaders(apiKey);

    try {
      const res = await axios.post(
        'https://api.subsource.net/api/v1/subtitles/download',
        { subId: subId },
        { headers, timeout: 8000 }
      );

      const downloadUrl = res.data?.data?.downloadUrl || res.data?.downloadUrl || res.data?.url;
      if (downloadUrl) {
        const fileRes = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        return Buffer.from(fileRes.data);
      }
    } catch (e) {}

    const directRes = await axios.get(
      `https://api.subsource.net/api/v1/subtitles/${subId}/download`,
      {
        headers,
        responseType: 'arraybuffer',
        timeout: 10000
      }
    );

    return Buffer.from(directRes.data);
  } catch (err) {
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
