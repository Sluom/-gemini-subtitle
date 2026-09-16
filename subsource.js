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

    // فلترة اللغات (عربي وإنكليزي)
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

      return {
        id: `subsource_${subId}`,
        url: `subsource://${subId}?key=${encodeURIComponent(activeKey)}`,
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

    if (!subId) return debug ? { error: 'No subId provided' } : Buffer.from('');

    const headers = getHeaders(apiKey);

    // المحاولة 1: POST الرسمي مع قراءة استجابة خام (ArrayBuffer)
    try {
      const res = await axios.post(
        'https://api.subsource.net/api/v1/subtitles/download',
        { subId: subId, subtitleId: subId },
        { headers, responseType: 'arraybuffer', timeout: 10000 }
      );

      const buf = Buffer.from(res.data);
      attempts.push({ type: 'POST /download', status: res.status, byteLength: buf.length });

      // فحص هل الرد JSON يحتوي رابط خارجي أم هو الملف المباشر
      try {
        const text = buf.toString('utf-8');
        const json = JSON.parse(text);
        let dlUrl = json.downloadUrl || json.data?.downloadUrl || json.url || json.data?.url;
        if (dlUrl) {
          if (dlUrl.startsWith('/')) dlUrl = `https://api.subsource.net${dlUrl}`;
          const fileRes = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 10000 });
          const finalBuf = Buffer.from(fileRes.data);
          if (debug) return { success: true, attempts, bufferLength: finalBuf.length, preview: finalBuf.slice(0, 160).toString('utf-8') };
          return finalBuf;
        }
      } catch (notJson) {
        // الرد هو ملف الترجمة المباشر
        if (buf.length > 0) {
          if (debug) return { success: true, attempts, bufferLength: buf.length, preview: buf.slice(0, 160).toString('utf-8') };
          return buf;
        }
      }
    } catch (e1) {
      attempts.push({ type: 'POST /download', error: e1.response?.status || e1.message });
    }

    // المحاولة 2: إرسال subId كرقم
    try {
      const numId = parseInt(subId, 10);
      if (!isNaN(numId)) {
        const resNum = await axios.post(
          'https://api.subsource.net/api/v1/subtitles/download',
          { subId: numId },
          { headers, responseType: 'arraybuffer', timeout: 10000 }
        );
        const buf = Buffer.from(resNum.data);
        attempts.push({ type: 'POST /download (numeric)', status: resNum.status, byteLength: buf.length });

        try {
          const text = buf.toString('utf-8');
          const json = JSON.parse(text);
          let dlUrl = json.downloadUrl || json.data?.downloadUrl || json.url || json.data?.url;
          if (dlUrl) {
            if (dlUrl.startsWith('/')) dlUrl = `https://api.subsource.net${dlUrl}`;
            const fileRes = await axios.get(dlUrl, { responseType: 'arraybuffer', timeout: 10000 });
            const finalBuf = Buffer.from(fileRes.data);
            if (debug) return { success: true, attempts, bufferLength: finalBuf.length, preview: finalBuf.slice(0, 160).toString('utf-8') };
            return finalBuf;
          }
        } catch (e) {
          if (buf.length > 0) {
            if (debug) return { success: true, attempts, bufferLength: buf.length, preview: buf.slice(0, 160).toString('utf-8') };
            return buf;
          }
        }
      }
    } catch (e2) {
      attempts.push({ type: 'POST /download (numeric)', error: e2.response?.status || e2.message });
    }

    // المحاولة 3: مسار GET المباشر
    try {
      const res3 = await axios.get(
        `https://api.subsource.net/api/v1/subtitles/download/${subId}`,
        { headers, responseType: 'arraybuffer', timeout: 10000 }
      );
      const buf3 = Buffer.from(res3.data);
      attempts.push({ type: 'GET /download/:id', status: res3.status, byteLength: buf3.length });
      if (buf3.length > 0) {
        if (debug) return { success: true, attempts, bufferLength: buf3.length, preview: buf3.slice(0, 160).toString('utf-8') };
        return buf3;
      }
    } catch (e3) {
      attempts.push({ type: 'GET /download/:id', error: e3.response?.status || e3.message });
    }

    if (debug) return { success: false, attempts, bufferLength: 0, preview: '' };
    return Buffer.from('');
  } catch (err) {
    if (debug) return { error: err.message, attempts };
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
