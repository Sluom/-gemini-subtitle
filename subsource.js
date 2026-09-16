const axios = require('axios');

function getHeaders(apiKey) {
  return {
    'X-API-Key': apiKey || '',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }, debugMode = false) {
  const logs = { apiKeyReceived: !!apiKey, imdbId, title };
  if (!apiKey) {
    if (debugMode) return { error: 'SubSource API Key is MISSING', logs };
    return [];
  }

  try {
    let movie = null;
    let cleanTitle = (title || '').replace(/\([^)]*\)/g, '').trim();

    // 1. البحث باسم الفلم
    if (cleanTitle && !cleanTitle.startsWith('tt')) {
      try {
        const textUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(cleanTitle)}&searchType=text`;
        const res = await axios.get(textUrl, { headers: getHeaders(apiKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) movie = list[0];
      } catch (e) {
        logs.textSearchError = e.response?.status || e.message;
      }
    }

    // 2. البحث بـ IMDb إذا لم يعثر عليه بالاسم
    if (!movie && imdbId && imdbId.startsWith('tt')) {
      try {
        const imdbUrl = `https://api.subsource.net/api/v1/movies/search?q=${imdbId}&searchType=imdb`;
        const res = await axios.get(imdbUrl, { headers: getHeaders(apiKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) movie = list[0];
      } catch (e) {
        logs.imdbSearchError = e.response?.status || e.message;
      }
    }

    if (!movie) {
      if (debugMode) return { error: 'Movie not found on SubSource', logs };
      return [];
    }

    // استخراج linkName الرسمي الخاص بـ SubSource
    const linkName = movie.linkName || movie.slug || movie.id;
    logs.foundMovie = movie.title;
    logs.linkName = linkName;

    if (!linkName) {
      if (debugMode) return { error: 'Missing linkName in movie object', rawMovie: movie, logs };
      return [];
    }

    // 3. طلب الترجمات الرسمي عبر POST بمصفوفة اللغات الرسمية
    let list = [];
    try {
      const postRes = await axios.post(
        'https://api.subsource.net/api/v1/subtitles/search',
        {
          movie: linkName,
          lang: ['Arabic', 'English']
        },
        { headers: getHeaders(apiKey), timeout: 8000 }
      );
      list = postRes.data?.data || postRes.data?.subtitles || [];
      logs.postStatus = postRes.status;
    } catch (e) {
      logs.postError = e.response?.status || e.message;
      
      // مسار احتياطي عبر GET في حال تغيرت استجابة الـ API
      try {
        const getRes = await axios.get(
          `https://api.subsource.net/api/v1/subtitles?movie=${encodeURIComponent(linkName)}&lang=arabic,english`,
          { headers: getHeaders(apiKey), timeout: 7000 }
        );
        list = getRes.data?.data || getRes.data?.subtitles || [];
      } catch (e2) {}
    }

    logs.totalSubsFound = list.length;
    if (debugMode) return { success: true, logs, subsCount: list.length, sample: list[0] || null };

    if (!list.length) return [];

    // تصفية أرقام الحلقات في حالة المسلسلات
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
