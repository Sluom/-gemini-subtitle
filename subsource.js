const axios = require('axios');

function getHeaders(apiKey) {
  return {
    'X-API-Key': apiKey || '',
    'auth-key': apiKey || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }, debugMode = false) {
  const logs = { apiKeyReceived: !!apiKey, imdbId, title };
  if (!apiKey) {
    if (debugMode) return { error: 'SubSource API Key is MISSING in Server Request', logs };
    return [];
  }

  try {
    let movie = null;
    let cleanTitle = (title || '').replace(/\([^)]*\)/g, '').trim();

    // المحاولة الأولى: البحث باسم الفلم الصافي
    if (cleanTitle && !cleanTitle.startsWith('tt')) {
      try {
        const textUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(cleanTitle)}&searchType=text`;
        const res = await axios.get(textUrl, { headers: getHeaders(apiKey), timeout: 6000 });
        logs.textSearchStatus = res.status;
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) movie = list[0];
      } catch (e) {
        logs.textSearchError = e.response?.status || e.message;
      }
    }

    // المحاولة الثانية: البحث بكود IMDb إذا لم يعثر عليه بالاسم
    if (!movie && imdbId && imdbId.startsWith('tt')) {
      try {
        const imdbUrl = `https://api.subsource.net/api/v1/movies/search?q=${imdbId}&searchType=imdb`;
        const res = await axios.get(imdbUrl, { headers: getHeaders(apiKey), timeout: 6000 });
        logs.imdbSearchStatus = res.status;
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) movie = list[0];
      } catch (e) {
        logs.imdbSearchError = e.response?.status || e.message;
      }
    }

    logs.matchedMovie = movie ? (movie.slug || movie.title) : null;
    if (!movie) {
      if (debugMode) return { error: 'Movie not found on SubSource database', logs };
      return [];
    }

    const movieSlug = movie.slug || movie.id;
    let list = [];

    // جلب الترجمات
    try {
      const subUrl = `https://api.subsource.net/api/v1/subtitles/movie/${movieSlug}?lang=arabic,english`;
      const subRes = await axios.get(subUrl, { headers: getHeaders(apiKey), timeout: 6000 });
      logs.subsGetStatus = subRes.status;
      list = subRes.data?.data || subRes.data?.subtitles || [];
    } catch (e) {
      logs.subsGetError = e.response?.status || e.message;
      // محاولة بديلة عبر POST إذا فشل الـ GET
      try {
        const postRes = await axios.post('https://api.subsource.net/api/v1/subtitles/search', 
          { movie: movieSlug, lang: ['Arabic', 'English'] }, 
          { headers: getHeaders(apiKey), timeout: 6000 }
        );
        list = postRes.data?.data || postRes.data?.subtitles || [];
      } catch (e2) {}
    }

    logs.totalSubsFound = list.length;
    if (debugMode) return { success: true, logs, subsCount: list.length, sample: list[0] || null };

    if (!list.length) return [];

    return list.map(item => {
      const subId = item.id || item.subId || item.file;
      const lang = (item.language || item.lang || '').toLowerCase();
      const name = item.release_name || item.name || '';
      const isAss = name.toLowerCase().endsWith('.ass');

      return {
        id: `subsource_${subId}`,
        url: `subsource://${subId}?key=${encodeURIComponent(apiKey)}`,
        lang: lang.includes('arab') || lang.includes('ar') ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        _source: 'subsource',
        _priority: 2
      };
    });
  } catch (err) {
    if (debugMode) return { fatalError: err.message, logs };
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
      { headers: getHeaders(apiKey), timeout: 10000 }
    );

    const downloadUrl = res.data?.data?.downloadUrl || res.data?.downloadUrl;
    if (downloadUrl) {
      const fileRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 10000 });
      return Buffer.from(fileRes.data);
    }
    return Buffer.from('');
  } catch (err) {
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
