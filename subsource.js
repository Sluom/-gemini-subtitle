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
    const query = title || imdbId;
    if (!query) return [];

    // استخدام q= بدلاً من query= لضمان استجابة SubSource
    const searchUrl = `https://api.subsource.net/api/v1/movies/search?q=${encodeURIComponent(query)}&searchType=text`;
    const searchRes = await axios.get(searchUrl, {
      headers: getHeaders(apiKey),
      timeout: 7000
    });

    const data = searchRes.data?.data || searchRes.data?.movies || [];
    if (!data || !data.length) return [];

    const movie = data[0];
    const movieSlug = movie.slug || movie.id;
    if (!movieSlug) return [];

    const subUrl = `https://api.subsource.net/api/v1/subtitles/list?movie=${movieSlug}&lang=arabic,english`;
    const subRes = await axios.get(subUrl, {
      headers: getHeaders(apiKey),
      timeout: 7000
    });

    let list = subRes.data?.data || subRes.data?.subtitles || [];
    if (!list || !list.length) return [];

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

      // صيغة رابط مخصصة ومحمية من أخطاء الـ URL parsing
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
    // استخراج subId والمفتاح بدقة بدون تكسير المسار
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
