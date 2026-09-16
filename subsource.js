const axios = require('axios');

function getHeaders(apiKey) {
  const key = apiKey || process.env.SUBSOURCE_API_KEY || '';
  return {
    'X-API-Key': key,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
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

    // 2. البحث بـ IMDb
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

    // تصفية اللغات (عربي وإنكليزي)
    const validSubs = list.filter(item => {
      const l = (item.Language || item.language || item.lang || '').toLowerCase();
      return l.includes('arab') || l === 'ar' || l.includes('eng') || l === 'en';
    });

    logs.validSubsFound = validSubs.length;
    list = validSubs.length > 0 ? validSubs : list;

    // تصفية أرقام الحلقات للمسلسلات
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
      const itemLink = item.link || '';

      return {
        id: `subsource_${subId}`,
        url: `subsource://${subId}?key=${encodeURIComponent(activeKey)}&link=${encodeURIComponent(itemLink)}`,
        lang: isArabic ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        _source: 'subsource',
        _priority: isArabic ? 1 : 2
      };
    });

    if (debugMode) {
      let testDownload = null;
      if (results.length > 0) {
        testDownload = await fetchSubSourceBuffer(results[0].url, true);
      }
      return { success: true, logs, totalValid: results.length, sample: results[0] || null, testDownload };
    }

    return results;
  } catch (err) {
    if (debugMode) return { fatalError: err.message, logs };
    return [];
  }
}

async function fetchSubSourceBuffer(customUrl, debug = false) {
  const attempts = [];
  try {
    const cleanUrl = customUrl.replace('subsource://', '');
    const [subIdPart, queryPart] = cleanUrl.split('?');
    const subId = subIdPart;
    const urlParams = new URLSearchParams(queryPart || '');
    const apiKey = urlParams.get('key') || process.env.SUBSOURCE_API_KEY || '';
    const itemLink = urlParams.get('link') || '';

    if (!subId) return debug ? { error: 'No subId provided' } : Buffer.from('');

    const headers = getHeaders(apiKey);

    // دالة مساعدة لتنزيل الرابط أو قراءة البيانات
    async function handleResponse(res, type) {
      const buf = Buffer.from(res.data);
      attempts.push({ type, status: res.status, byteLength: buf.length });

      try {
        const text = buf.toString('utf-8');
        const json = JSON.parse(text);
        let dlUrl = json.downloadUrl || json.data?.downloadUrl || json.url || json.data?.url || json.file;
        if (dlUrl) {
          if (dlUrl.startsWith('/')) dlUrl = `https://api.subsource.net${dlUrl}`;
          const fileRes = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 10000 });
          return Buffer.from(fileRes.data);
        }
      } catch (e) {
        if (buf.length > 0) return buf;
      }
      return null;
    }

    // 1. فحص تفاصيل الترجمة (GET /api/v1/subtitles/:id)
    try {
      const res1 = await axios.get(`https://api.subsource.net/api/v1/subtitles/${subId}`, {
        headers,
        responseType: 'arraybuffer',
        timeout: 8000
      });
      const data = await handleResponse(res1, `GET /subtitles/${subId}`);
      if (data && data.length > 0) {
        if (debug) return { success: true, attempts, bufferLength: data.length, preview: data.slice(0, 160).toString('utf-8') };
        return data;
      }
    } catch (e1) {
      attempts.push({ type: `GET /subtitles/${subId}`, error: e1.response?.status || e1.message });
    }

    // 2. فحص مسار التحميل المباشر (GET /api/v1/subtitles/:id/download)
    try {
      const res2 = await axios.get(`https://api.subsource.net/api/v1/subtitles/${subId}/download`, {
        headers,
        responseType: 'arraybuffer',
        timeout: 8000
      });
      const data = await handleResponse(res2, `GET /subtitles/${subId}/download`);
      if (data && data.length > 0) {
        if (debug) return { success: true, attempts, bufferLength: data.length, preview: data.slice(0, 160).toString('utf-8') };
        return data;
      }
    } catch (e2) {
      attempts.push({ type: `GET /subtitles/${subId}/download`, error: e2.response?.status || e2.message });
    }

    // 3. فحص POST بمسار /api/v1/subtitles/:id/download
    try {
      const res3 = await axios.post(`https://api.subsource.net/api/v1/subtitles/${subId}/download`, {}, {
        headers,
        responseType: 'arraybuffer',
        timeout: 8000
      });
      const data = await handleResponse(res3, `POST /subtitles/${subId}/download`);
      if (data && data.length > 0) {
        if (debug) return { success: true, attempts, bufferLength: data.length, preview: data.slice(0, 160).toString('utf-8') };
        return data;
      }
    } catch (e3) {
      attempts.push({ type: `POST /subtitles/${subId}/download`, error: e3.response?.status || e3.message });
    }

    // 4. إذا كان متوفر itemLink نجرب جلبه عبر API
    if (itemLink) {
      try {
        const cleanLink = itemLink.startsWith('/') ? itemLink : `/${itemLink}`;
        const res4 = await axios.get(`https://api.subsource.net/api/v1${cleanLink}`, {
          headers,
          responseType: 'arraybuffer',
          timeout: 8000
        });
        const data = await handleResponse(res4, `GET /api/v1${cleanLink}`);
        if (data && data.length > 0) {
          if (debug) return { success: true, attempts, bufferLength: data.length, preview: data.slice(0, 160).toString('utf-8') };
          return data;
        }
      } catch (e4) {
        attempts.push({ type: `GET /api/v1${itemLink}`, error: e4.response?.status || e4.message });
      }
    }

    if (debug) return { success: false, attempts, bufferLength: 0, preview: '' };
    return Buffer.from('');
  } catch (err) {
    if (debug) return { error: err.message, attempts };
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
