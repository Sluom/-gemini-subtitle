const axios = require('axios');

function getHeaders(apiKey) {
  return {
    'X-API-Key': apiKey || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }) {
  if (!apiKey) return [];

  try {
    let movie = null;

    // 1. البحث بكود IMDb أولاً
    if (imdbId && imdbId.startsWith('tt')) {
      try {
        const imdbUrl = `https://api.subsource.net/api/v1/movies/search?query=${imdbId}&searchType=imdb`;
        const res = await axios.get(imdbUrl, {
          headers: getHeaders(apiKey),
          timeout: 6000
        });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = list[0];
        }
      } catch (e) {}
    }

    // 2. إذا لم يعثر عليه بـ IMDb يبحث بالاسم
    if (!movie && title && !title.startsWith('tt')) {
      try {
        const cleanTitle = title.replace(/\([^)]*\)/g, '').trim();
        const textUrl = `https://api.subsource.net/api/v1/movies/search?query=${encodeURIComponent(cleanTitle)}&searchType=text`;
        const res = await axios.get(textUrl, {
          headers: getHeaders(apiKey),
          timeout: 6000
        });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = list[0];
        }
      } catch (e) {}
    }

    if (!movie) return [];

    const movieSlug = movie.slug || movie.id;
    if (!movieSlug) return [];

    // 3. سحب الترجمات عبر POST حصراً مع مصفوفة اللغات الرسمية
    const subRes = await axios.post(
      'https://api.subsource.net/api/v1/subtitles/search',
      {
        movie: movieSlug,
        lang: ['Arabic', 'English']
      },
      {
        headers: getHeaders(apiKey),
        timeout: 7000
      }
    );

    let list = subRes.data?.data || subRes.data?.subtitles || [];
    if (!list || !list.length) return [];

    // مطابقة الحلقة للمسلسلات
    if (season && episode) {
      const sNum = parseInt(season, 10);
      const eNum = parseInt(episode, 10);
      const epRegex = new RegExp(`(?:s0*${sNum})?(?:e|ep|episode)0*${eNum}(?:[^0-9]|$)`, 'i');

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
      const subId = item.id || item.subId || item.file;
      const lang = (item.language || item.lang || '').toLowerCase();
      const name = item.release_name || item.name || '';
      const isAss = name.toLowerCase().endsWith('.ass');

      const url = `subsource://${subId}?key=${encodeURIComponent(apiKey)}`;

      return {
        id: `subsource_${subId}`,
        url: url,
        lang: lang.includes('arab') || lang.includes('ar') ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        _source: 'subsource',
        _priority: 2
      };
    });
  } catch (err) {
    return [];
  }
}

async function fetchSubSourceBuffer(customUrl) {
  try {
    const cleanUrl = customUrl.replace('subsource://', '');
    const [subIdPart, queryPart] = cleanUrl.split('?');
    const subId = subIdPart;
    const urlParams = new URLSearchParams(queryPart || '');
    const apiKey = urlParams.get('key') || '';

    if (!subId) return Buffer.from('');

    const res = await axios.post(
      'https://api.subsource.net/api/v1/subtitles/download',
      { subId: subId },
      {
        headers: getHeaders(apiKey),
        timeout: 10000
      }
    );

    const downloadUrl = res.data?.data?.downloadUrl || res.data?.downloadUrl;
    if (downloadUrl) {
      const fileRes = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      return Buffer.from(fileRes.data);
    }

    return Buffer.from('');
  } catch (err) {
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
