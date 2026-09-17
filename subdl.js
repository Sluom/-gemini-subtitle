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
  if (key.length > 40 && !key.includes(' ') && !key.startsWith('fz')) return key;
  try {
    const rawConfig = `${key}/AR/hiInclude/`;
    return Buffer.from(rawConfig).toString('base64').replace(/=/g, '');
  } catch (e) {
    return defaultPath;
  }
}

function checkIsAssFormat(item) {
  const strDump = [
    item.sub_format, item.format, item.type, item.release_name,
    item.name, item.url, item.file_name, item.author, item.id
  ].filter(Boolean).join(' ').toLowerCase();

  if (item.url && item.url.toLowerCase().endsWith('.srt')) return false;

  if (strDump.includes('.ass') || strDump.includes('.ssa') || strDump.includes('[ass]') || strDump.includes('styled') || /\b(ass|ssa)\b/.test(strDump)) {
    return true;
  }
  
  const animeGroups = ['erai', 'subsplease', 'horrible', 'judas', 'golumpa', 'ember', 'yameii', 'seadex', 'commie', 'vcb', 'nyaa', 'dame', 'mtbb', 'saiko', 'an-raws', 'animetok', 'msoms', 'shahiid', 'xotaku', 'an-sub', 'katsugeki', 'stardima', 'c-a', 'okanime'];
  if (animeGroups.some(g => strDump.includes(g))) {
    return true;
  }
  return false;
}

function processSubDLItems(list, type, episode) {
  return list.flatMap(item => {
    const langRaw = (item.lang || item.language || 'Arabic').toLowerCase();
    const isAr = langRaw.startsWith('ar') || langRaw === 'ara';
    
    if (!isAr) return [];

    let dlUrl = item.url || '';
    if (dlUrl && !dlUrl.startsWith('http')) {
      dlUrl = `https://dl.subdl.com${dlUrl.startsWith('/') ? '' : '/'}${dlUrl}`;
    }

    const releaseName = item.release_name || item.name || item.id || 'SubDL';
    const isAssRadar = checkIsAssFormat(item);
    const results = [];

    // إذا الرادار متأكد إنها ASS، نرسلها كـ ass حصراً
    if (isAssRadar) {
      results.push({
        url: dlUrl, lang: 'ara', format: 'ass', ext: 'ass', subFormat: 'ass',
        fileName: releaseName, origName: releaseName, _source: 'subdl',
        _isZip: !dlUrl.endsWith('.srt') && !dlUrl.endsWith('.ass'), _episode: episode || 1, _priority: 0
      });
    } 
    // ميزة الاستنساخ: إذا كان العمل أنمي وماكو دليل، ننطي نسختين للمشاهد وهو يختار
    else if (type === 'anime') {
      results.push({
        url: dlUrl, lang: 'ara', format: 'ass', ext: 'ass', subFormat: 'ass',
        fileName: '[ASS] ' + releaseName, origName: '[ASS] ' + releaseName, _source: 'subdl',
        _isZip: true, _episode: episode || 1, _priority: 1
      });
      results.push({
        url: dlUrl, lang: 'ara', format: 'srt', ext: 'srt', subFormat: 'srt',
        fileName: '[SRT] ' + releaseName, origName: '[SRT] ' + releaseName, _source: 'subdl',
        _isZip: true, _episode: episode || 1, _priority: 2
      });
    } 
    // الأفلام والمسلسلات العادية تبقى SRT
    else {
      results.push({
        url: dlUrl, lang: 'ara', format: 'srt', ext: 'srt', subFormat: 'srt',
        fileName: releaseName, origName: releaseName, _source: 'subdl',
        _isZip: !dlUrl.endsWith('.srt'), _episode: episode || 1, _priority: 2
      });
    }

    return results;
  }).filter(s => s.url);
}

async function fetchSubDLOfficial(imdbId, season, episode, type, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const params = new URLSearchParams({ api_key: apiKey.trim(), imdb_id: imdbId, languages: 'AR' });
    if (season) params.set('season_number', String(season));
    if (episode) params.set('episode_number', String(episode));
    
    // الإصلاح الجوهري: معالجة الأنمي كمسلسل لمنع خطأ Invalid Request
    const isSeries = type === 'series' || type === 'anime' || !!season;
    if (type) params.set('type', isSeries ? 'series' : 'movie');

    const res = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json' }, timeout: 8000
    });
    
    if (!res.data?.status || !Array.isArray(res.data?.subtitles)) return [];
    return processSubDLItems(res.data.subtitles, type, episode);
  } catch (e) { return []; }
}

async function fetchSubDLStremTop(imdbId, season, episode, type, apiKey) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const configPath = buildSubDLStremConfig(apiKey);
    
    // الإصلاح الجوهري للأنمي
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const endpointType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    
    const requestUrl = `https://subdl.strem.top/${configPath}/subtitles/${endpointType}/${targetId}.json`;
    const res = await axios.get(requestUrl, {
      headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json' }, timeout: 9000
    });
    
    if (!Array.isArray(res.data?.subtitles)) return [];
    return processSubDLItems(res.data.subtitles, type, episode);
  } catch (err) { return []; }
}

async function fetchSubDLMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    // الإصلاح الجوهري للأنمي
    const isSeries = type === 'series' || type === 'anime' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const mirrorTargetId = season ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    
    const r = await axios.get(`https://subdl-stremio.vercel.app/subtitles/${mediaType}/${mirrorTargetId}.json`, {
      headers: { 'User-Agent': getRandomUA() }, timeout: 5000
    });
    return processSubDLItems(r.data?.subtitles || [], type, episode);
  } catch (e) { return []; }
}

async function getSubDL({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const requests = [];
  if (apiKey) requests.push(fetchSubDLOfficial(imdbId, season, episode, type, apiKey));
  requests.push(fetchSubDLStremTop(imdbId, season, episode, type, apiKey));
  requests.push(fetchSubDLMirror(imdbId, season, episode, type));

  const results = await Promise.allSettled(requests);
  const allSubs = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

  // نظام فلترة لمنع التكرار بدقة
  const uniqueSubs = [];
  const seenUrls = new Set();
  for (const sub of allSubs) {
    const dedupKey = `${sub.url.split('?')[0]}-${sub.format}`;
    if (seenUrls.has(dedupKey)) continue;
    seenUrls.add(dedupKey);
    uniqueSubs.push(sub);
  }

  return uniqueSubs;
}

module.exports = { getSubDL };
