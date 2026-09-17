const axios = require('axios');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildSubDLStremConfig(apiKey) {
  const defaultPath = 'ZnptR0ozSjBGdDFXS003T1UyTHQ2bnhfLWx1b2FkNUwvQVIvaGlJbmNsdWRlLw';
  const key = (apiKey || process.env.SUBDL_API_KEY || '').trim();

  if (!key) return defaultPath;

  if (key.length > 40 && !key.includes(' ') && !key.startsWith('fz')) {
    return key;
  }

  try {
    const rawConfig = `${key}/AR/hiInclude/`;
    return Buffer.from(rawConfig).toString('base64').replace(/=/g, '');
  } catch (e) {
    return defaultPath;
  }
}

// دالة الكشف الذكية: تعتمد على الدلائل القاطعة وتخرج بصيغة ssa حصراً
function checkIsAssFormat(item) {
  const strDump = [
    item.sub_format, item.format, item.type, item.release_name,
    item.name, item.url, item.file_name, item.author, item.id
  ].filter(Boolean).join(' ').toLowerCase();

  // إذا كان الرابط نفسه ينتهي بـ srt فهو srt قطعا
  if (item.url && item.url.toLowerCase().endsWith('.srt')) return false;

  // 1. الدلائل الصريحة لوجود ASS/SSA
  if (strDump.includes('.ass') || strDump.includes('.ssa') || strDump.includes('[ass]') || strDump.includes('[ssa]') || strDump.includes('styled') || /\b(ass|ssa)\b/.test(strDump)) {
    return true;
  }

  // 2. فرق الأنمي المشهورة (تمت إضافة الفرق العربية والأجنبية)
  const animeGroups = ['erai', 'subsplease', 'horrible', 'judas', 'golumpa', 'ember', 'yameii', 'seadex', 'commie', 'vcb', 'nyaa', 'dame', 'mtbb', 'saiko', 'an-raws', 'animetok'];
  if (animeGroups.some(g => strDump.includes(g))) {
    return true;
  }

  return false;
}

async function fetchSubDLOfficial(imdbId, season, episode, type, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const params = new URLSearchParams({
      api_key: apiKey.trim(),
      imdb_id: imdbId,
      languages: 'AR,EN'
    });

    if (season) params.set('season_number', String(season));
    if (episode) params.set('episode_number', String(episode));
    if (type) params.set('type', type === 'series' ? 'series' : 'movie');

    const res = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'application/json'
      },
      timeout: 8000
    });

    if (!res.data?.status || !Array.isArray(res.data?.subtitles)) return [];

    return res.data.subtitles.map(item => {
      const langRaw = (item.lang || item.language || 'Arabic').toLowerCase();
      const isAr = langRaw.startsWith('ar') || langRaw === 'ara';
      const releaseName = item.release_name || item.name || '';
      
      const isAss = checkIsAssFormat(item); 

      let dlUrl = item.url || '';
      if (dlUrl && !dlUrl.startsWith('http')) {
        dlUrl = `https://dl.subdl.com${dlUrl.startsWith('/') ? '' : '/'}${dlUrl}`;
      }

      // توحيد الصيغة لـ ssa ليقرأها تطبيق Nuvio بشكل صحيح
      const cleanFormat = isAss ? 'ssa' : 'srt';

      return {
        url: dlUrl,
        lang: isAr ? 'ara' : 'eng',
        format: cleanFormat,
        ext: cleanFormat,
        subFormat: cleanFormat,
        fileName: releaseName,
        origName: releaseName || 'SubDL Official',
        _source: 'subdl',
        _isZip: true,
        _episode: episode || 1,
        _priority: isAr ? (isAss ? 0 : 1) : 3
      };
    }).filter(s => s.url && s.lang === 'ara'); 
  } catch (e) {
    return [];
  }
}

async function fetchSubDLStremTop(imdbId, season, episode, type, apiKey) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const configPath = buildSubDLStremConfig(apiKey);
    const isSeries = type === 'series' || !!season;
    const endpointType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

    const requestUrl = `https://subdl.strem.top/${configPath}/subtitles/${endpointType}/${targetId}.json`;

    const res = await axios.get(requestUrl, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'application/json'
      },
      timeout: 9000
    });

    const list = res.data?.subtitles || [];
    if (!Array.isArray(list)) return [];

    return list.map(item => {
      const langRaw = (item.lang || 'ara').toLowerCase();
      const isArabic = langRaw.startsWith('ar') || langRaw === 'ara';
      const isAss = checkIsAssFormat(item);
      const cleanFormat = isAss ? 'ssa' : 'srt'; // الاعتماد على ssa

      return {
        url: item.url,
        lang: isArabic ? 'ara' : 'eng',
        format: cleanFormat,
        ext: cleanFormat,
        subFormat: cleanFormat,
        fileName: item.id || '',
        origName: item.id || 'SubDL Strem',
        _source: 'subdl',
        _isZip: false, 
        _priority: isArabic ? (isAss ? 0 : 2) : 3
      };
    }).filter(s => s.url && s.lang === 'ara');
  } catch (err) {
    return [];
  }
}

async function fetchSubDLMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const mediaType = season ? 'series' : (type === 'series' ? 'series' : 'movie');
    const mirrorTargetId = season ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    const r = await axios.get(
      `https://subdl-stremio.vercel.app/subtitles/${mediaType}/${mirrorTargetId}.json`,
      {
        headers: { 'User-Agent': getRandomUA() },
        timeout: 5000
      }
    );

    return (r.data?.subtitles || []).map(s => {
      const langRaw = (s.lang || 'ara').toLowerCase();
      const isArabic = langRaw.startsWith('ar');
      const isAss = checkIsAssFormat(s);
      const cleanFormat = isAss ? 'ssa' : 'srt'; // الاعتماد على ssa

      return {
        url: s.url,
        lang: isArabic ? 'ara' : 'eng',
        format: cleanFormat,
        ext: cleanFormat,
        subFormat: cleanFormat,
        fileName: s.title || s.name || '',
        origName: s.title || s.name || 'SubDL Mirror',
        _source: 'subdl',
        _isZip: false,
        _priority: isArabic ? (isAss ? 0 : 2) : 3
      };
    }).filter(s => s.url && s.lang === 'ara');
  } catch (e) {
    return [];
  }
}

async function getSubDL({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const requests = [];

  if (apiKey) {
    requests.push(fetchSubDLOfficial(imdbId, season, episode, type, apiKey));
  }

  requests.push(fetchSubDLStremTop(imdbId, season, episode, type, apiKey));
  requests.push(fetchSubDLMirror(imdbId, season, episode, type));

  const results = await Promise.allSettled(requests);
  
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getSubDL };
