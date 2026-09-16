const axios = require('axios');

function getHeaders(apiKey) {
  const key = apiKey || process.env.SUBSOURCE_API_KEY || '';
  return {
    'X-API-Key': key,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }, debugMode = false) {
  const activeKey = apiKey || process.env.SUBSOURCE_API_KEY || '';
  const logs = { apiKeyReceived: !!activeKey, imdbId, title };
  if (!activeKey) {
    if (debugMode) return { error: 'SubSource API Key is MISSING', logs };
    return [];
  }

  try {
    let movie = null;
    let cleanTitle = (title || '').replace(/\([^)]*\)/g, '').trim();

    // 1. البحث باسم العمل
    if (cleanTitle && !cleanTitle.startsWith('tt')) {
      try {
        const textUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(cleanTitle)}&searchType=text`;
        const res = await axios.get(textUrl, { headers: getHeaders(activeKey), timeout: 7000 });
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
        const res = await axios.get(imdbUrl, { headers: getHeaders(activeKey), timeout: 7000 });
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

    const movieId = movie.movieId || movie.id;
    logs.foundMovie = movie.title;
    logs.movieId = movieId;

    if (!movieId) return [];

    // 3. جلب قائمة الترجمات
    const getRes = await axios.get(
      `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}`,
      { headers: getHeaders(activeKey), timeout: 8000 }
    );

    let list = getRes.data?.data || getRes.data?.subtitles || [];
    logs.rawSubsFound = list.length;
    if (!list.length) return [];

    // قراءة الحقل بدقة سواء كان Language أو language أو lang
    const validSubs = list.filter(item => {
      const l = (item.Language || item.language || item.lang || '').toLowerCase();
      return l.includes('arab') || l === 'ar' || l.includes('eng') || l === 'en';
    });

    logs.validSubsFound = validSubs.length;
    list = validSubs.length > 0 ? validSubs : list;

    // تصفية الحلقات للمسلسلات
    if (season && episode) {
      const sNum = parseInt(season, 10);
      const eNum = parseInt(episode, 10);
      const epRegex = new RegExp(`(?:s0*${sNum})?(?:e|ep|episode)0*${eNum}(?:[^0-9]|$)`, 'i');

      const filtered = list.filter(item => {
        if (item.season && item.episode) {
          return parseInt(item.season, 10) === sNum && parseInt(item.episode, 10) === eNum;
        }
        const relName = (Array.isArray(item.releaseInfo) ? item.releaseInfo[0] : '') || item.release_name || item.name || '';
        return epRegex.test(relName);
      });

      if (filtered.length > 0) {
        list = filtered;
      }
    }

    const results = list.map(item => {
      const subId = item.subtitleId || item.subId || item.id;
      const langRaw = (item.Language || item.language || item.lang || '').toLowerCase();
      const isArabic = langRaw.includes('arab') || langRaw === 'ar';
      
      const relName = (Array.isArray(item.releaseInfo) ? item.releaseInfo[0] : '') || item.release_name || item.name || '';
      const isAss = relName.toLowerCase().endsWith('.ass');

      return {
        id: `subsource_${subId}`,
        url: `subsource://${subId}?key=${encodeURIComponent(activeKey)}`,
        lang: isArabic ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        _source: 'subsource',
        _priority: isArabic ? 1 : 2
      };
    });

    // في وضع الفحص: نجري محاولة تحميل حية لأول ترجمة للتأكد من احتوائها على نصوص
    if (debugMode) {
      let testDownload = null;
      if (results.length > 0) {
        try {
          const testBuf = await fetchSubSourceBuffer(results[0].url);
          testDownload = {
            testedSubId: results[0].id,
            bufferLength: testBuf ? testBuf.length : 0,
            hasContent: testBuf && testBuf.length > 0,
            preview: testBuf ? testBuf.slice(0, 160).toString('utf-8') : 'empty'
          };
        } catch (err) {
          testDownload = { error: err.message };
        }
      }
      return { success: true, logs, totalValid: results.length, sample: results[0] || null, testDownload };
    }

    return results;
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
    const apiKey = urlParams.get('key') || process.env.SUBSOURCE_API_KEY || '';

    if (!subId) return Buffer.from('');

    const headers = {
      'X-API-Key': apiKey,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Content-Type': 'application/json'
    };

    // المحاولة 1: POST الرسمي إلى /api/v1/subtitles/download
    try {
      const res = await axios.post(
        'https://api.subsource.net/api/v1/subtitles/download',
        { subId: subId, subtitleId: subId },
        { headers, timeout: 10000 }
      );

      let downloadUrl = res.data?.downloadUrl || res.data?.data?.downloadUrl || res.data?.url || res.data?.data?.url;
      
      if (downloadUrl) {
        if (downloadUrl.startsWith('/')) {
          downloadUrl = `https://api.subsource.net${downloadUrl}`;
        }
        const fileRes = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (fileRes.data && fileRes.data.byteLength > 0) {
          return Buffer.from(fileRes.data);
        }
      }
      
      if (Buffer.isBuffer(res.data) && res.data.length > 0) {
        return res.data;
      }
    } catch (e1) {}

    // المحاولة 2: GET المباشر إلى /api/v1/subtitles/download/:id
    try {
      const res2 = await axios.get(
        `https://api.subsource.net/api/v1/subtitles/download/${subId}`,
        { headers, responseType: 'arraybuffer', timeout: 10000 }
      );
      if (res2.data && res2.data.byteLength > 0) {
        return Buffer.from(res2.data);
      }
    } catch (e2) {}

    return Buffer.from('');
  } catch (err) {
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
