const axios = require('axios');

function getConfigPath(apiKey) {
  const defaultPath = 'c2tfNTJkNzQ5NGZiYzdmYWE0ZDYwY2I2NTIwYzNlMWNjNzAzYzBjNTFkNjcyNzJmNjE4MWEzNGU2MDYxNTI1Y2EyMi9hcmFiaWMvaGlJbmNsdWRlL3R5cGU6MC8';
  const key = apiKey || process.env.SUBSOURCE_API_KEY || '';

  if (!key) return defaultPath;

  if (key.startsWith('c2tf') || (key.length > 50 && !key.startsWith('sk_'))) {
    return key;
  }

  try {
    return Buffer.from(`${key}/arabic/hiInclude/type:0/`).toString('base64');
  } catch (e) {
    return defaultPath;
  }
}

async function getSubSource({ title, imdbId, season, episode, type, apiKey }, debugMode = false) {
  const activeKey = apiKey || process.env.SUBSOURCE_API_KEY || '';
  const logs = { apiKeyReceived: !!activeKey, imdbId, title, season, episode, type };

  if (!imdbId || !imdbId.startsWith('tt')) {
    if (debugMode) return { error: 'Valid IMDb ID is required', logs };
    return [];
  }

  try {
    const configPath = getConfigPath(activeKey);
    const isSeries = type === 'series' || !!season;
    
    let targetId = imdbId;
    if (isSeries && season) {
      targetId = `${imdbId}:${season}:${episode || 1}`;
    }

    const endpointType = isSeries ? 'series' : 'movie';
    const requestUrl = `https://subsource.strem.top/${configPath}/subtitles/${endpointType}/${targetId}.json`;
    logs.requestUrl = requestUrl;

    const res = await axios.get(requestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 9000
    });

    const list = res.data?.subtitles || [];
    logs.rawSubsFound = list.length;

    if (!Array.isArray(list) || list.length === 0) {
      if (debugMode) return { error: 'No subtitles returned from service', logs };
      return [];
    }

    const results = list.map((item, index) => {
      const rawLang = (item.lang || '').toLowerCase();
      const isArabic = rawLang === 'ara' || rawLang === 'ar' || rawLang.includes('arab');
      const directUrl = item.url || '';
      const isAss = directUrl.toLowerCase().endsWith('.ass') || (item.id || '').toLowerCase().endsWith('.ass');

      return {
        id: item.id || `subsource_${index + 1}`,
        url: directUrl,
        lang: isArabic ? 'ara' : (item.lang || 'eng'),
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
    if (debugMode) {
      return {
        fatalError: err.message,
        status: err.response?.status,
        data: err.response?.data,
        logs
      };
    }
    return [];
  }
}

async function fetchSubSourceBuffer(customUrl, debug = false) {
  try {
    if (!customUrl) return Buffer.from('');

    let downloadUrl = customUrl;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    };

    if (customUrl.startsWith('subsource://')) {
      const cleanUrl = customUrl.replace('subsource://', '');
      const [subIdPart, queryPart] = cleanUrl.split('?');
      const subId = subIdPart;
      const urlParams = new URLSearchParams(queryPart || '');
      const apiKey = urlParams.get('key') || process.env.SUBSOURCE_API_KEY || '';

      if (!subId) return Buffer.from('');
      downloadUrl = `https://api.subsource.net/api/v1/subtitles/${subId}/download`;
      headers['X-API-Key'] = apiKey;
    }

    const res = await axios.get(downloadUrl, {
      headers,
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
