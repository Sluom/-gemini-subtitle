const axios = require('axios');

function getHeaders(apiKey) {
  const key = apiKey || process.env.SUBSOURCE_API_KEY || '';
  return {
    'X-API-Key': key,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
}

function pickBestMovie(list, cleanTitle, sNum) {
  if (!list || !list.length) return null;

  // 1. إذا كان مسلسل، نفحص إذا كان السيرفر مسجل مواسم منفصلة بالاسم
  if (sNum) {
    const seasonRegex = new RegExp(`(?:season|s)[._ -]*0*${sNum}\\b`, 'i');
    const seasonMatch = list.find(m => seasonRegex.test(m.title || m.name || ''));
    if (seasonMatch) return seasonMatch;
  }

  // 2. مطابقة اسم العمل الأصلي تماماً
  const exactMatch = list.find(m => (m.title || m.name || '').trim().toLowerCase() === cleanTitle.toLowerCase());
  if (exactMatch) return exactMatch;

  return list[0];
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }, debugMode = false) {
  const activeKey = apiKey || process.env.SUBSOURCE_API_KEY || '';
  const logs = { apiKeyReceived: !!activeKey, imdbId, title, season, episode };
  if (!activeKey) {
    if (debugMode) return { error: 'SubSource API Key is MISSING', logs };
    return [];
  }

  try {
    let movie = null;
    let cleanTitle = (title || '').replace(/\([^)]*\)/g, '').trim();
    const sNum = season ? parseInt(season, 10) : null;
    const eNum = episode ? parseInt(episode, 10) : null;

    // 1. البحث باسم العمل الصافي فقط (بدون إضافة Season لتفادي تصفير نتائج البحث)
    if (cleanTitle && !cleanTitle.startsWith('tt')) {
      try {
        const textUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(cleanTitle)}&searchType=text`;
        const res = await axios.get(textUrl, { headers: getHeaders(activeKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = pickBestMovie(list, cleanTitle, sNum);
        }
      } catch (e) {
        logs.textSearchError = e.response?.status || e.message;
      }
    }

    // 2. البحث بـ IMDb كخيار بديل إذا لم يعثر عليه بالاسم
    if (!movie && imdbId && imdbId.startsWith('tt')) {
      try {
        const imdbUrl = `https://api.subsource.net/api/v1/movies/search?q=${imdbId}&searchType=imdb`;
        const res = await axios.get(imdbUrl, { headers: getHeaders(activeKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = pickBestMovie(list, cleanTitle, sNum);
        }
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

    // 3. جلب الترجمات التابعة للعمل
    const getRes = await axios.get(
      `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}`,
      { headers: getHeaders(activeKey), timeout: 8000 }
    );

    let list = getRes.data?.data || getRes.data?.subtitles || [];
    logs.rawSubsFound = list.length;
    if (!list.length) return [];

    // 4. فلترة اللغات (عربي وإنكليزي حصراً)
    list = list.filter(item => {
      const l = (item.Language || item.language || item.lang || '').toLowerCase();
      return l.includes('arab') || l === 'ar' || l.includes('eng') || l === 'en';
    });

    if (!list.length) return [];

    // 5. فلترة الموسم والحلقة للمسلسلات بشكل إجباري ومحكم
    if (sNum && eNum) {
      const sPattern = `0*${sNum}`;
      const ePattern = `0*${eNum}`;

      const strictPatterns = [
        new RegExp(`(?:s|season[._ -]*)${sPattern}[._ -]*(?:e|ep|episode)[._ -]*${ePattern}(?:[^0-9]|$)`, 'i'),
        new RegExp(`\\b${sPattern}x${ePattern}\\b`, 'i'),
        new RegExp(`\\[${sPattern}[._ -]*[xe][._ -]*${ePattern}\\]`, 'i')
      ];

      list = list.filter(item => {
        // فحص حقول الموسم والحلقة المباشرة إذا وفرها السيرفر
        const itemS = item.season != null && item.season !== '' ? parseInt(item.season, 10) : null;
        const itemE = item.episode != null && item.episode !== '' ? parseInt(item.episode, 10) : null;

        if (itemS !== null && itemE !== null && !isNaN(itemS) && !isNaN(itemE)) {
          return itemS === sNum && itemE === eNum;
        }

        // فحص أسماء ملفات النسخ بنمط إجباري يطابق الموسم والحلقة معاً
        const names = [
          ...(Array.isArray(item.releaseInfo) ? item.releaseInfo : [item.releaseInfo]),
          item.release_name,
          item.releaseName,
          item.name,
          item.fileName
        ].filter(Boolean);

        return names.some(n => strictPatterns.some(rx => rx.test(n)));
      });
    } else if (sNum) {
      // في حال كان الطلب لموسم كامل فقط
      const seasonRegex = new RegExp(`(?:s|season[._ -]*)${sNum}(?:[^0-9]|$)`, 'i');
      list = list.filter(item => {
        const itemS = item.season != null && item.season !== '' ? parseInt(item.season, 10) : null;
        if (itemS !== null && !isNaN(itemS)) return itemS === sNum;

        const names = [
          ...(Array.isArray(item.releaseInfo) ? item.releaseInfo : [item.releaseInfo]),
          item.release_name,
          item.releaseName,
          item.name,
          item.fileName
        ].filter(Boolean);

        return names.some(n => seasonRegex.test(n));
      });
    }

    logs.matchedSubsCount = list.length;

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
      const testDownload = results.length > 0 ? await fetchSubSourceBuffer(results[0].url, true) : null;
      return { success: true, logs, totalValid: results.length, sample: results[0] || null, testDownload };
    }

    return results;
  } catch (err) {
    if (debugMode) return { fatalError: err.message, logs };
    return [];
  }
}

async function fetchSubSourceBuffer(customUrl, debug = false) {
  try {
    const cleanUrl = customUrl.replace('subsource://', '');
    const [subIdPart, queryPart] = cleanUrl.split('?');
    const subId = subIdPart;
    const urlParams = new URLSearchParams(queryPart || '');
    const apiKey = urlParams.get('key') || process.env.SUBSOURCE_API_KEY || '';

    if (!subId) return Buffer.from('');

    const downloadUrl = `https://api.subsource.net/api/v1/subtitles/${subId}/download`;
    const res = await axios.get(downloadUrl, {
      headers: {
        'X-API-Key': apiKey,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      responseType: 'arraybuffer',
      timeout: 10000
    });

    const buf = Buffer.from(res.data);
    if (debug) {
      return { success: true, bufferLength: buf.length, preview: buf.slice(0, 160).toString('utf-8') };
    }
    return buf;
  } catch (err) {
    if (debug) return { error: err.message, bufferLength: 0 };
    return Buffer.from('');
  }
}

module.exports = { getSubSource, fetchSubSourceBuffer };
