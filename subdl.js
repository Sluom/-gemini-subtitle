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

// دالة فحص ذكية مطورة تكشف صيغ ASS حتى لو كانت مخفية داخل أسماء فرق الأنمي
function checkIsAssFormat(item) {
  const checkTargets = [
    item.sub_format,
    item.format,
    item.type,
    item.release_name,
    item.name,
    item.url,
    item.file_name,
    item.author
  ].filter(Boolean).map(v => String(v).toLowerCase());

  // فرق الأنمي المشهورة اللي دائماً ترفع ترجماتها بصيغة ASS حصراً
  const animeGroups = [
    'erai-raws', 'subsplease', 'horriblesubs', 'judas', 'golumpa', 
    'asw', 'dkb', 'btt', 'ember', 'subs-please', 'yameii', 'seadex',
    'commie', 'coalgirls', 'kamigami', 'mtbb'
  ];

  return checkTargets.some(str => {
    // الفحص العادي للامتدادات
    if (str.includes('.ass') || str.includes('.ssa') || str === 'ass' || str === 'ssa' || str.includes('styled') || str.includes('[ass]')) {
      return true;
    }
    // الفحص الذكي: إذا اسم الإصدار تابع لفرقة أنمي، نعتبره ASS فوراً
    if (animeGroups.some(group => str.includes(group))) {
      return true;
    }
    return false;
  });
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

      const cleanFormat = isAss ? 'ass' : 'srt';

      return {
        url: dlUrl,
        lang: isAr ? 'ara' : 'eng',
        format: cleanFormat,
        ext: cleanFormat,
        fileName: releaseName,
        origName: releaseName || 'SubDL Official',
        _source: 'subdl',
        _isZip: true,
        _episode: episode || 1,
        _priority: isAr ? (isAss ? 0 : 1) : 3
      };
    }).filter(s => s.url);
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
      const cleanFormat = isAss ? 'ass' : 'srt';

      return {
        url: item.url,
        lang: isArabic ? 'ara' : 'eng',
        format: cleanFormat,
        ext: cleanFormat,
        fileName: item.id || '',
        origName: item.id || 'SubDL Strem',
        _source: 'subdl',
        _isZip: false,
        _priority: isArabic ? (isAss ? 0 : 2) : 3
      };
    }).filter(s => s.url);
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
      const isArabic = (s.lang || 'ara').toLowerCase().startsWith('ar');
      const isAss = checkIsAssFormat(s);
      const cleanFormat = isAss ? 'ass' : 'srt';

      return {
        url: s.url,
        lang: isArabic ? 'ara' : 'eng',
        format: cleanFormat,
        ext: cleanFormat,
        fileName: s.title || s.name || '',
        origName: s.title || s.name || 'SubDL Mirror',
        _source: 'subdl',
        _isZip: false,
        _priority: isArabic ? (isAss ? 0 : 2) : 3
      };
    });
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
  const allSubs = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);

  // نظام فلترة لمنع تكرار نفس الترجمة من السيرفرات الثلاثة
  const uniqueSubs = [];
  const seenUrls = new Set();

  for (const sub of allSubs) {
    // توحيد الرابط لغرض الفلترة (إزالة بروتوكول http/https لحذف النسخ المتطابقة بدقة)
    const cleanUrl = sub.url.replace(/^https?:\/\//, '').split('?')[0];
    if (seenUrls.has(cleanUrl)) continue;
    seenUrls.add(cleanUrl);
    uniqueSubs.push(sub);
  }

  return uniqueSubs;
}

module.exports = { getSubDL };
