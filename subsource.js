const axios = require('axios');

function getHeaders(apiKey) {
  const key = apiKey || process.env.SUBSOURCE_API_KEY || '';
  return {
    'X-API-Key': key,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
}

function pickSeasonMovie(list, sNum) {
  if (!list || !list.length) return null;
  if (!sNum) return list[0];

  const seasonNum = parseInt(sNum, 10);

  // 1. مطابقة خاصية season إذا كانت موجودة كحقل صريح
  const byProp = list.find(m => {
    const s = m.season != null ? parseInt(m.season, 10) : null;
    return s === seasonNum;
  });
  if (byProp) return byProp;

  // 2. مطابقة الاسم إذا كان يحتوي Season X أو S0X
  const seasonRegex = new RegExp(`(?:season|s)[._ -]*0*${seasonNum}\\b`, 'i');
  const byTitle = list.find(m => seasonRegex.test(m.title || m.name || ''));
  if (byTitle) return byTitle;

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

    // 1. في المسلسلات: البحث باسم العمل مع رقم الموسم مباشرة لاستهداف الصفحة الصحيحة
    if (cleanTitle && sNum && !cleanTitle.startsWith('tt')) {
      try {
        const queryWithSeason = `${cleanTitle} Season ${sNum}`;
        const searchUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(queryWithSeason)}&searchType=text`;
        const res = await axios.get(searchUrl, { headers: getHeaders(activeKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = pickSeasonMovie(list, sNum);
        }
      } catch (e) {}
    }

    // 2. البحث بالاسم الصافي إذا لم يعثر عليه
    if (!movie && cleanTitle && !cleanTitle.startsWith('tt')) {
      try {
        const textUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(cleanTitle)}&searchType=text`;
        const res = await axios.get(textUrl, { headers: getHeaders(activeKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = sNum ? pickSeasonMovie(list, sNum) : list[0];
        }
      } catch (e) {}
    }

    // 3. البحث بـ IMDb
    if (!movie && imdbId && imdbId.startsWith('tt')) {
      try {
        const imdbUrl = `https://api.subsource.net/api/v1/movies/search?q=${imdbId}&searchType=imdb`;
        const res = await axios.get(imdbUrl, { headers: getHeaders(activeKey), timeout: 7000 });
        const list = res.data?.data || res.data?.movies || [];
        if (list.length > 0) {
          movie = sNum ? pickSeasonMovie(list, sNum) : list[0];
        }
      } catch (e) {}
    }

    if (!movie) {
      if (debugMode) return { error: 'Movie not found on SubSource', logs };
      return [];
    }

    const movieId = movie.movieId || movie.id;
    logs.selectedMovieTitle = movie.title;
    logs.movieId = movieId;

    if (!movieId) return [];

    // 4. جلب الترجمات الخاصة بالصفحة المختارة
    const getRes = await axios.get(
      `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}`,
      { headers: getHeaders(activeKey), timeout: 8000 }
    );

    let list = getRes.data?.data || getRes.data?.subtitles || [];
    logs.rawSubsFound = list.length;
    if (!list.length) return [];

    // فلترة اللغات (العربية والإنجليزية)
    const validSubs = list.filter(item => {
      const l = (item.Language || item.language || item.lang || '').toLowerCase();
      return l.includes('arab') || l === 'ar' || l.includes('eng') || l === 'en';
    });

    list = validSubs.length > 0 ? validSubs : list;

    // 5. مطابقة رقم الحلقة
    if (eNum) {
      const epRegex = new RegExp(`(?:e|ep|episode)[._ -]*0*${eNum}(?:[^0-9]|$)`, 'i');
      const numMatchRegex = new RegExp(`[._ -[\(]0*${eNum}[._ -\]\)]`, 'i');
      const sXPattern = sNum ? new RegExp(`(?:s|season)?0*${sNum}[._ -]*(?:e|ep|x)0*${eNum}(?:[^0-9]|$)`, 'i') : null;

      const matched = list.filter(item => {
        // فحص الخصائص المباشرة للكائن
        const itemE = item.episode != null ? parseInt(item.episode, 10) : null;
        if (itemE !== null && !isNaN(itemE)) {
          return itemE === eNum;
        }

        // فحص أسماء ملفات النسخ
        const names = [
          ...(Array.isArray(item.releaseInfo) ? item.releaseInfo : [item.releaseInfo]),
          item.release_name,
          item.releaseName,
          item.name,
          item.fileName
        ].filter(Boolean);

        return names.some(n => {
          if (sXPattern && sXPattern.test(n)) return true;
          if (epRegex.test(n)) return true;
          return numMatchRegex.test(n);
        });
      });

      if (matched.length > 0) {
        list = matched;
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
