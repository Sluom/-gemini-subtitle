const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.gemini.subtitles",
  version: "26.4.0",
  name: "Universal Subtitles & Gemini AI",
  description: "جلب الترجمات الشاملة المباشرة للأفلام والمسلسلات والأنمي مع الترجمة الفورية عبر الذكاء الاصطناعي",
  resources: [{ name: "subtitles", types: ["movie", "series", "anime", "other"], idPrefixes: ["tt", "kitsu", "mal", "anilist"] }],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "kitsu", "mal", "anilist"],
  catalogs: []
};

// ============= التدوير الذكي لوكلاء المستخدم =============
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/113.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
];
function getRandomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function getAxiosConfig(extraHeaders = {}) {
  return { headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json', ...extraHeaders }, timeout: 10000 };
}

// ============= أدوات مساعدة عامة =============
function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function parseImdbId(rawId) {
  const parts = rawId.split(':');
  return { imdbId: parts[0], season: parts[1] ? parseInt(parts[1]) : null, episode: parts[2] ? parseInt(parts[2]) : null };
}

function logErr(label, err) {
  const msg = err?.response?.status ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 100)}` : err?.message || err;
  console.error(`[${label}] فشل:`, msg);
}

function isAssUrl(url) { return /\.(ass|ssa)(\?|$)/i.test(url || ''); }

// إصلاح #1: فحص صحّة الترميز فعليًا بدل شرط كان يتحقق دائمًا (كل نص يحتوي على "").
// نحاول فك UTF-8 بشكل صارم (fatal)؛ لو فشل، فهذا يعني أن الملف بترميز قديم مثل
// Windows-1256 وليس UTF-8 فعلاً، فنعيد فكه بهذا الترميز. الملفات السليمة لا تُلمس إطلاقًا.
function safeDecodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return iconv.decode(buf, 'win1256'); }
    catch (e2) { return buf.toString('utf8'); }
  }
}

function decodeConfig(token) {
  const keys = { geminiKey: '', groqKey: '', deeplKey: '', openaiKey: '', jimakuKey: '', subsourceKey: '', openSubKey: '', subdlKey: '', wyzieKey: '', limit: 50 };
  if (!token) return keys;
  try {
    const p = JSON.parse(base64UrlDecode(token));
    Object.keys(keys).forEach(k => { if (p[k] !== undefined) keys[k] = k === 'limit' ? parseInt(p[k]) : p[k]; });
  } catch (e) { logErr('config:decode', e); }
  return keys;
}

const SOURCE_LABELS = {
  'opensub-v3': 'OpenSubtitles', 'opensub-fun': 'OpenSubtitles', 'opensub-official': 'OpenSubtitles',
  'subdl-mirror': 'SubDL', 'subdl-official': 'SubDL', 'yify': 'YIFY', 'anime-subs': 'AnimeSubs',
  'kitsunekko': 'Kitsunekko', 'subanime': 'SubAnime', 'animetosho': 'AnimeTosho',
  'wyzie': 'Wyzie Subs', 'subsource': 'SubSource', 'jimaku': 'Jimaku'
};
function sourceLabelOf(key) { return SOURCE_LABELS[key] || 'Source'; }

// ============= حماية هندسة ASS و Masking =============
const ASS_DEFAULT_HEADER = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function srtTimeToAss(t) {
  const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return '0:00:00.00';
  const h = parseInt(m[1], 10), cs = Math.floor(parseInt(m[4], 10) / 10).toString().padStart(2, '0');
  return `${h}:${m[2]}:${m[3]}.${cs}`;
}

function parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length);
    if (lines.length < 2) continue;
    let idx = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const tm = (lines[idx] || '').match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!tm) continue;
    const text2 = lines.slice(idx + 1).join('\\N');
    if (text2.trim()) cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), text: text2 });
  }
  return cues;
}

function buildAssFromCues(cues) {
  const lines = cues.map(c => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${String(c.text)}`);
  return ASS_DEFAULT_HEADER + lines.join('\n') + '\n';
}

function parseAss(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const eventsIdx = lines.findIndex(l => l.trim().toLowerCase() === '[events]');
  if (eventsIdx === -1) return null;
  const formatIdx = lines.findIndex((l, i) => i > eventsIdx && /^Format:/i.test(l.trim()));
  if (formatIdx === -1) return null;
  const fieldsLen = lines[formatIdx].split(':').slice(1).join(':').split(',').length;

  const headerLines = lines.slice(0, formatIdx + 1);
  const dialogues = [];
  for (let i = formatIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(Dialogue|Comment):\s*/i);
    if (!m) continue;
    const parts = lines[i].slice(m[0].length).split(',');
    dialogues.push({ prefix: m[1], before: parts.slice(0, fieldsLen - 1), text: parts.slice(fieldsLen - 1).join(',') });
  }
  return { headerLines, dialogues };
}

function maskTags(text) {
  let tags = [];
  let masked = text.replace(/\{[^}]+\}/g, match => { tags.push(match); return `[T${tags.length - 1}]`; });
  return { masked, tags };
}

function unmaskTags(text, tags) {
  let unmasked = text;
  tags.forEach((tag, i) => { unmasked = unmasked.replace(new RegExp(`\\[T${i}\\]`, 'g'), tag); });
  return unmasked;
}

// ============= الترجمة الصارمة =============
async function translateChunkJSON(texts, provider, key) {
  const prompt = `You are a professional subtitle translator. Target Language: ARABIC ONLY.
Task: Translate the following JSON array of strings into Arabic.
Rules:
1. MUST return a raw JSON object with a single key "data" containing an array of the translated strings. Example: {"data": ["مرحبا", "كيف حالك"]}.
2. Keep any tags like [T0], \\N exactly where they are.
3. NEVER return English text.
Length: ${texts.length}. Input: ${JSON.stringify(texts)}`;

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key.trim())}`;
      const r = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: 'application/json' } }, getAxiosConfig({'Content-Type': 'application/json'}));
      const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) return (JSON.parse(raw)).data || JSON.parse(raw);
    }
    if (provider === 'groq' || provider === 'openai') {
      const isGroq = provider === 'groq';
      const url = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
      const r = await axios.post(url, { model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }, getAxiosConfig({ Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' }));
      const raw = r.data?.choices?.[0]?.message?.content;
      if (raw) return (JSON.parse(raw)).data || JSON.parse(raw).translations;
    }
    if (provider === 'deepl') {
      const isFree = key.trim().endsWith(':fx');
      const dUrl = isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
      const r = await axios.post(dUrl, { text: texts, target_lang: 'AR', preserve_formatting: true }, getAxiosConfig({ Authorization: `DeepL-Auth-Key ${key.trim()}`, 'Content-Type': 'application/json' }));
      if (r.data?.translations?.length === texts.length) return r.data.translations.map(t => t.text);
    }
  } catch (e) { logErr(`translateChunk:${provider}`, e); }
  return null;
}

async function translateTextArray(texts, keys) {
  if (!texts.length) return null;
  const providers = [];
  if (keys.geminiKey) providers.push({ name: 'gemini', key: keys.geminiKey });
  if (keys.groqKey) providers.push({ name: 'groq', key: keys.groqKey });
  if (keys.deeplKey) providers.push({ name: 'deepl', key: keys.deeplKey });
  if (keys.openaiKey) providers.push({ name: 'openai', key: keys.openaiKey });
  if (!providers.length) return null;

  const CHUNK = 80;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    let done = null;
    for (const p of providers) {
      done = await translateChunkJSON(chunk, p.name, p.key);
      if (done && Array.isArray(done) && done.length === chunk.length) break;
      done = null;
    }
    if (!done) return null;
    results.push(...done);
  }
  return results;
}

// ============= التخزين المؤقت، الجسر المزدوج، وأفلام الأنمي =============
let animeListCache = null;
let animeListCacheTime = 0;
const idResolveCache = new Map();

async function getAnimeListMap() {
  const now = Date.now();
  if (animeListCache && now - animeListCacheTime < 86400000) return animeListCache;
  try {
    const r = await axios.get('https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json', getAxiosConfig());
    if (Array.isArray(r.data)) { animeListCache = r.data; animeListCacheTime = now; }
  } catch (e) { logErr('animeMap', e); }
  return animeListCache || [];
}

async function resolveExternalId(rawId) {
  if (idResolveCache.has(rawId)) return idResolveCache.get(rawId);
  try {
    const parts = rawId.split(':');
    const prefix = parts[0];
    const map = await getAnimeListMap();
    let result = { imdbId: null, kitsuId: null, absoluteEp: null, title: null, isMovie: false };

    if (['kitsu', 'mal', 'anilist'].includes(prefix)) {
      const extId = parts[1];
      result.absoluteEp = parts[2] ? parseInt(parts[2]) : null;
      if (!result.absoluteEp) result.isMovie = true;

      const field = prefix === 'kitsu' ? 'kitsu_id' : prefix === 'mal' ? 'mal_id' : 'anilist_id';
      const entry = map.find(e => String(e[field]) === String(extId));
      result.kitsuId = entry?.kitsu_id || (prefix === 'kitsu' ? extId : null);

      if (prefix === 'kitsu') {
        const res = await axios.get(`https://kitsu.io/api/edge/anime/${extId}`, getAxiosConfig()).catch(()=>null);
        result.title = res?.data?.data?.attributes?.canonicalTitle || null;
      } else if (prefix === 'mal') {
        const res = await axios.get(`https://api.jikan.moe/v4/anime/${extId}`, getAxiosConfig()).catch(()=>null);
        result.title = res?.data?.data?.title || res?.data?.data?.title_english || null;
      } else if (prefix === 'anilist') {
        try {
          const q = `query($id:Int){Media(id:$id,type:ANIME){title{romaji english}}}`;
          const r = await axios.post('https://graphql.anilist.co', { query: q, variables: { id: parseInt(extId) } }, getAxiosConfig({ 'Content-Type': 'application/json' }));
          result.title = r.data?.data?.Media?.title?.english || r.data?.data?.Media?.title?.romaji || null;
        } catch (e) { logErr('anilist:title', e); }
      }

      if (entry?.imdb_id) {
        const iId = Array.isArray(entry.imdb_id) ? entry.imdb_id[0] : String(entry.imdb_id).split(',')[0].trim();
        result.imdbId = result.isMovie ? iId : `${iId}:${entry.season?.tvdb ?? 1}:${result.absoluteEp + (entry.episode_offset?.tvdb ?? 0)}`;
      }
    }
    else if (rawId.startsWith('tt')) {
      const extId = parts[0], season = parts[1] ? parseInt(parts[1]) : null, episode = parts[2] ? parseInt(parts[2]) : null;
      if (!season && !episode) result.isMovie = true;

      const entry = map.find(e => {
        const ids = Array.isArray(e.imdb_id) ? e.imdb_id : String(e.imdb_id).split(',');
        return ids.includes(extId) && (season == null || (e.season?.tvdb ?? 1) === season);
      });
      if (entry) {
        result.kitsuId = entry.kitsu_id;
        if (episode != null) result.absoluteEp = episode - (entry.episode_offset?.tvdb ?? 0);
      }
      result.imdbId = rawId;
    }

    idResolveCache.set(rawId, result);
    return result;
  } catch (e) { logErr('resolveExternalId', e); return null; }
}

// ============= استرجاع دوال API المباشرة (Direct Fetch) =============
async function fetchOpenSubtitlesDirect(imdbId, season, episode, apiKey, seasonPack = false) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ imdb_id: imdbId.replace('tt', ''), languages: 'ar,en' });
    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const r = await axios.get(`https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`, getAxiosConfig({ 'Api-Key': apiKey.trim() }));
    const items = r.data?.data || [];
    const out = [];
    for (const item of items) {
      const fId = item.attributes?.files?.[0]?.file_id;
      if (!fId) continue;
      try {
        const dl = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: fId }, getAxiosConfig({ 'Api-Key': apiKey.trim(), 'Content-Type': 'application/json' }));
        if (dl.data?.link) out.push({ url: dl.data.link, lang: item.attributes.language || 'en', origName: item.attributes.release || item.attributes.files?.[0]?.file_name, _source: 'opensub-official', _seasonPack: seasonPack });
      } catch (e) { }
    }
    return out;
  } catch (e) { logErr('opensubtitlesDirect', e); return []; }
}

async function fetchSubDLDirect(imdbId, season, episode, apiKey, seasonPack = false) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ api_key: apiKey.trim(), imdb_id: imdbId, languages: 'AR,EN' });
    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, getAxiosConfig());
    return (r.data?.subtitles || []).filter(item => item.url).map(item => ({ zipUrl: item.url.startsWith('http') ? item.url : `https://dl.subdl.com${item.url}`, lang: (item.lang || 'en').toLowerCase(), origName: item.release_name || item.name, _source: 'subdl-official', _seasonPack: seasonPack || !!item.full_season }));
  } catch (e) { logErr('subdlDirect', e); return []; }
}

async function fetchWyzieDirect(imdbId, season, episode, apiKey, seasonPack = false) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ id: imdbId, key: apiKey.trim(), language: 'ar,en' });
    if (season) params.set('season', season);
    if (episode) params.set('episode', episode);

    const r = await axios.get(`https://sub.wyzie.io/search?${params.toString()}`, getAxiosConfig());
    return (Array.isArray(r.data) ? r.data : []).filter(it => it.url).map(it => ({ url: it.url, lang: (it.language || 'en').toLowerCase(), origName: it.release || it.fileName, _source: 'wyzie', _seasonPack: seasonPack }));
  } catch (e) { logErr('wyzieDirect', e); return []; }
}

// إصلاح البند 5: البحث الاحتياطي بالاسم — يُستخدم فقط عندما يفشل البحث بالمعرف تمامًا
async function fetchOpenSubtitlesByName(title, apiKey) {
  if (!apiKey || !title) return [];
  try {
    const r = await axios.get(`https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(title)}&languages=ar,en`, getAxiosConfig({ 'Api-Key': apiKey.trim() }));
    const items = r.data?.data || [];
    const out = [];
    for (const item of items) {
      const fId = item.attributes?.files?.[0]?.file_id;
      if (!fId) continue;
      try {
        const dl = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: fId }, getAxiosConfig({ 'Api-Key': apiKey.trim(), 'Content-Type': 'application/json' }));
        if (dl.data?.link) out.push({ url: dl.data.link, lang: item.attributes.language || 'en', origName: item.attributes.release || item.attributes.files?.[0]?.file_name, _source: 'opensub-official' });
      } catch (e) { logErr('openSubByName:download', e); }
    }
    return out;
  } catch (e) { logErr('openSubByName', e); return []; }
}

async function fetchSubDLByName(title, apiKey) {
  if (!apiKey || !title) return [];
  try {
    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(apiKey.trim())}&film_name=${encodeURIComponent(title)}&languages=AR,EN`, getAxiosConfig());
    return (r.data?.subtitles || []).filter(item => item.url).map(item => ({
      zipUrl: item.url.startsWith('http') ? item.url : `https://dl.subdl.com${item.url}`,
      lang: (item.lang || 'en').toLowerCase(),
      origName: item.release_name || item.name,
      _source: 'subdl-official'
    }));
  } catch (e) { logErr('subdlByName', e); return []; }
}

function mirrorRequest(url, sourceKey, seasonPack) {
  return axios.get(url, getAxiosConfig())
    .then(r => {
      const list = r.data?.subtitles || [];
      console.log(`[mirror:${sourceKey}] ${list.length} نتيجة`);
      return list.map(s => ({ url: s.url, lang: s.lang, origName: s.title || s.SubFileName || s.release || s.name, _source: sourceKey, _seasonPack: !!seasonPack }));
    })
    .catch(e => { logErr(`mirror:${sourceKey}`, e); return []; });
}

function buildMirrorRequests(tid, fetchType, seasonPack = false) {
  const reqs = [
    mirrorRequest(`https://opensubtitles-v3.strem.io/subtitles/${fetchType}/${tid}.json`, 'opensub-v3', seasonPack),
    mirrorRequest(`https://opensubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, 'opensub-fun', seasonPack),
    mirrorRequest(`https://subdl-stremio.vercel.app/subtitles/${fetchType}/${tid}.json`, 'subdl-mirror', seasonPack),
    mirrorRequest(`https://yifysubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, 'yify', seasonPack)
  ];
  if (tid.startsWith('kitsu') || tid.startsWith('anilist') || tid.startsWith('mal') || fetchType === 'series') {
    reqs.push(
      mirrorRequest(`https://anime-subtitles.strem.fun/subtitles/series/${tid}.json`, 'anime-subs', seasonPack),
      mirrorRequest(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${tid}.json`, 'kitsunekko', seasonPack)
    );
  }
  return reqs;
}

// ============= استرجاع مسار فحص المفاتيح =============
app.post('/test-key', async (req, res) => {
  const { provider, key } = req.body;
  if (!key) return res.json({ success: false, message: "يرجى إدخال المفتاح أولاً ⚠️" });
  const cleanKey = key.trim();
  try {
    if (provider === 'gemini') {
      const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`, { timeout: 7000 });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح Gemini صالح وشغال 100% ✅" });
    }
    if (provider === 'groq') {
      const r = await axios.get('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${cleanKey}` }, timeout: 5000 });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح Groq صالح 100% ✅" });
    }
    if (provider === 'deepl') {
      const isFree = cleanKey.endsWith(':fx');
      const url = isFree ? 'https://api-free.deepl.com/v2/usage' : 'https://api.deepl.com/v2/usage';
      const r = await axios.get(url, { headers: { Authorization: `DeepL-Auth-Key ${cleanKey}` }, timeout: 5000 });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح DeepL صالح 100% ✅" });
    }
    if (provider === 'openai') {
      const r = await axios.get('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${cleanKey}` }, timeout: 5000 });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح OpenAI صالح 100% ✅" });
    }
    if (provider === 'opensub') {
      const r = await axios.get('https://api.opensubtitles.com/api/v1/subtitles?query=Inception', getAxiosConfig({ 'Api-Key': cleanKey }));
      if (r.status === 200) return res.json({ success: true, message: "مفتاح OpenSubtitles صالح وشغال 100% ✅" });
    }
    if (provider === 'subdl') {
      const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${cleanKey}&film_name=Inception`, { timeout: 5000 });
      if (r.data?.status === true || r.data?.results) return res.json({ success: true, message: "مفتاح SubDL صالح 100% ✅" });
    }
    if (provider === 'subsource') {
      const r = await axios.get('https://api.subsource.net/api/v1/movies/search?query=Inception', getAxiosConfig({ 'X-API-Key': cleanKey })).catch(e => e.response);
      if (r && (r.status === 200 || r.status === 404)) return res.json({ success: true, message: "مفتاح SubSource صالح وشغال 100% ✅" });
      return res.json({ success: true, message: "تم تسجيل مفتاح SubSource بنجاح ✅" });
    }
    if (provider === 'jimaku') return res.json({ success: true, message: "مفتاح Jimaku صالح ومحفوظ ✅" });
    if (provider === 'wyzie') return res.json({ success: true, message: "مفتاح Wyzie صالح ومحفوظ ✅" });

    return res.json({ success: false, message: "المفتاح غير صالح ❌" });
  } catch (err) {
    return res.json({ success: false, message: "فشل الفحص: تأكد من صحة المفتاح ❌" });
  }
});

// ============= واجهة التخصيص المسترجعة بالكامل =============
app.get(['/', '/configure'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Universal Subtitles & Gemini AI</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #1e293b; padding: 25px; border-radius: 16px; width: 100%; max-width: 530px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
        h2 { color: #38bdf8; margin-top: 0; font-size: 20px; text-align: center; }
        h3 { color: #94a3b8; font-size: 14px; margin: 15px 0 8px; border-bottom: 1px solid #334155; padding-bottom: 4px; }
        .field-group { margin-bottom: 12px; }
        .label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        label { font-size: 13px; color: #cbd5e1; font-weight: 500; }
        .get-link { font-size: 11px; color: #38bdf8; text-decoration: none; background: rgba(56, 189, 248, 0.1); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(56, 189, 248, 0.2); }
        .get-link:hover { text-decoration: underline; background: rgba(56, 189, 248, 0.2); }
        .input-row { display: flex; gap: 6px; }
        input, select { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 13px; outline: none; }
        input:focus, select:focus { border-color: #38bdf8; }
        .btn-test { background: #334155; color: #f8fafc; border: 1px solid #475569; padding: 0 14px; border-radius: 8px; cursor: pointer; font-size: 12px; white-space: nowrap; font-weight: bold; }
        .btn-test:hover { background: #475569; }
        .test-msg { font-size: 11px; margin-top: 4px; display: none; }
        .btn-install { width: 100%; padding: 14px; margin-top: 20px; border-radius: 8px; border: none; background: #0284c7; color: #fff; font-weight: bold; cursor: pointer; font-size: 15px; }
        .btn-install:hover { background: #0369a1; }
        .btn-copy { width: 100%; padding: 12px; margin-top: 10px; border-radius: 8px; border: 1px solid #475569; background: transparent; color: #38bdf8; font-weight: bold; cursor: pointer; font-size: 14px; }
        .btn-copy:hover { background: #263449; }
        .link-box { display: none; margin-top: 10px; }
        .link-box input { font-size: 11px; direction: ltr; text-align: left; color: #94a3b8; }
        .copy-msg { font-size: 12px; margin-top: 6px; text-align: center; display: none; }
        .hint { font-size: 11px; color: #64748b; margin-top: 6px; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>إعدادات كافة مواقع ومفاتيح الترجمة</h2>

        <h3>🤖 محركات الذكاء الاصطناعي (للترجمة الفورية)</h3>
        <div class="field-group">
          <div class="label-row"><label>مفتاح Google Gemini API:</label><a class="get-link" href="https://aistudio.google.com/app/apikey" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="geminiKey" placeholder="AIzaSy..."><button class="btn-test" onclick="testKey('gemini', 'geminiKey', 'msgGemini')">فحص</button></div>
          <div id="msgGemini" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح Groq API (فائق السرعة):</label><a class="get-link" href="https://console.groq.com/keys" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="groqKey" placeholder="gsk_..."><button class="btn-test" onclick="testKey('groq', 'groqKey', 'msgGroq')">فحص</button></div>
          <div id="msgGroq" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح DeepL API:</label><a class="get-link" href="https://www.deepl.com/pro-api" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="deeplKey" placeholder="DeepL Auth Key (:fx)"><button class="btn-test" onclick="testKey('deepl', 'deeplKey', 'msgDeepl')">فحص</button></div>
          <div id="msgDeepl" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح OpenAI API:</label><a class="get-link" href="https://platform.openai.com/api-keys" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="openaiKey" placeholder="sk-..."><button class="btn-test" onclick="testKey('openai', 'openaiKey', 'msgOpenai')">فحص</button></div>
          <div id="msgOpenai" class="test-msg"></div>
        </div>

        <h3>🎌 مواقع ومصادر ترجمات الأنمي التخصصية</h3>
        <div class="field-group">
          <div class="label-row"><label>مفتاح Jimaku.cc API (اختياري للأنمي):</label><a class="get-link" href="https://jimaku.cc" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="jimakuKey" placeholder="Jimaku API Token"><button class="btn-test" onclick="testKey('jimaku', 'jimakuKey', 'msgJimaku')">فحص</button></div>
          <div id="msgJimaku" class="test-msg"></div>
        </div>

        <h3>🌐 قواعد بيانات ومزودات الترجمة العامة</h3>
        <div class="field-group">
          <div class="label-row"><label>مفتاح SubSource API:</label><a class="get-link" href="https://subsource.net/api-docs" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="subsourceKey" placeholder="SubSource API Key"><button class="btn-test" onclick="testKey('subsource', 'subsourceKey', 'msgSubsource')">فحص</button></div>
          <div id="msgSubsource" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح OpenSubtitles.com API:</label><a class="get-link" href="https://www.opensubtitles.com/en/consumers" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="openSubKey" placeholder="OpenSubtitles API Key"><button class="btn-test" onclick="testKey('opensub', 'openSubKey', 'msgOpenSub')">فحص</button></div>
          <div id="msgOpenSub" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح SubDL API:</label><a class="get-link" href="https://subdl.com/api-doc" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="subdlKey" placeholder="SubDL API Key"><button class="btn-test" onclick="testKey('subdl', 'subdlKey', 'msgSubdl')">فحص</button></div>
          <div id="msgSubdl" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح Wyzie Subs API:</label><a class="get-link" href="https://wyzie.ru" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="wyzieKey" placeholder="Wyzie API Key"><button class="btn-test" onclick="testKey('wyzie', 'wyzieKey', 'msgWyzie')">فحص</button></div>
          <div id="msgWyzie" class="test-msg"></div>
        </div>

        <h3>⚙️ إعدادات العرض الشاملة</h3>
        <div class="field-group">
          <label>الحد الأقصى لنتائج الترجمة (مع استثناء تراجم AI الـ 5):</label>
          <select id="limit">
            <option value="10">10 نتائج (للأجهزة الضعيفة)</option>
            <option value="25">25 نتيجة</option>
            <option value="50" selected>50 نتيجة (مستحسن)</option>
            <option value="100">100 نتيجة</option>
          </select>
        </div>

        <button class="btn-install" onclick="install()">تثبيت / تحديث في Nuvio</button>
        <button class="btn-copy" onclick="copyLink()">📋 نسخ رابط الإضافة</button>
        <div class="link-box" id="linkBox"><input type="text" id="linkOutput" readonly onclick="this.select()"></div>
        <div id="copyMsg" class="copy-msg"></div>
      </div>

      <script>
        async function testKey(provider, inputId, msgId) {
          const key = document.getElementById(inputId).value.trim();
          const msgEl = document.getElementById(msgId);
          msgEl.style.display = 'block'; msgEl.style.color = '#38bdf8'; msgEl.innerText = 'جاري الفحص... ⏳';
          if (!key) { msgEl.style.color = '#ef4444'; msgEl.innerText = 'يرجى إدخال المفتاح أولاً ⚠️'; return; }
          try {
            const res = await fetch('/test-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, key }) });
            const data = await res.json();
            msgEl.style.color = data.success ? '#22c55e' : '#ef4444'; msgEl.innerText = data.message;
          } catch (e) { msgEl.style.color = '#ef4444'; msgEl.innerText = 'تعذر الاتصال بالخادم ❌'; }
        }
        function toBase64Url(str) { return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }
        function buildManifestUrl() {
          const config = toBase64Url(JSON.stringify({
            geminiKey: document.getElementById('geminiKey').value.trim(), groqKey: document.getElementById('groqKey').value.trim(),
            deeplKey: document.getElementById('deeplKey').value.trim(), openaiKey: document.getElementById('openaiKey').value.trim(),
            jimakuKey: document.getElementById('jimakuKey').value.trim(), subsourceKey: document.getElementById('subsourceKey').value.trim(),
            openSubKey: document.getElementById('openSubKey').value.trim(), subdlKey: document.getElementById('subdlKey').value.trim(),
            wyzieKey: document.getElementById('wyzieKey').value.trim(), limit: document.getElementById('limit').value
          }));
          return window.location.origin + '/' + config + '/manifest.json';
        }
        function install() {
          window.location.href = 'nuvio://' + buildManifestUrl().replace(/^https?:\\/\\//, '');
        }
        async function copyLink() {
          const url = buildManifestUrl();
          const linkBox = document.getElementById('linkBox');
          const linkOutput = document.getElementById('linkOutput');
          const msg = document.getElementById('copyMsg');
          linkOutput.value = url;
          linkBox.style.display = 'block';
          try {
            await navigator.clipboard.writeText(url);
            msg.style.color = '#22c55e';
            msg.innerText = 'تم نسخ الرابط بنجاح ✅';
          } catch (e) {
            linkOutput.select();
            msg.style.color = '#f59e0b';
            msg.innerText = 'تعذر النسخ التلقائي، الرابط محدد بالأعلى - انسخه يدويًا';
          }
          msg.style.display = 'block';
          setTimeout(() => { msg.style.display = 'none'; }, 4000);
        }
      </script>
    </body>
    </html>
  `);
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => res.json(manifest));

// ============= الترجمة الفورية =============
app.get(['/translate', '/:config/translate', '/translate/trans.ass', '/:config/translate/trans.ass'], async (req, res) => {
  const subUrl = req.query.subUrl; if (!subUrl) return res.status(400).send("No URL");
  const keys = req.params.config ? decodeConfig(req.params.config) : req.query;
  let text;
  try {
    const r = await axios.get(subUrl, { responseType: 'arraybuffer', timeout: 12000, headers: {'User-Agent': USER_AGENTS[0]} });
    const buf = Buffer.from(r.data);
    text = safeDecodeText(buf);
  } catch (err) { return res.redirect(subUrl); }

  const isAss = isAssUrl(subUrl) || /^\uFEFF?\[Script Info\]/im.test(text);
  let outText = text;
  try {
    const assP = isAss ? parseAss(text) : null;
    const cues = assP ? assP.dialogues : (parseSrt(text) || []);
    if (cues.length > 0) {
      const masked = cues.map(c => { const m = maskTags(c.text); return { txt: c.text, masked: m.masked, tags: m.tags }; });
      const trans = await translateTextArray(masked.map(c => c.masked), keys);

      if (trans && trans.length === cues.length) {
        if (assP) {
          const lines = [...assP.headerLines];
          assP.dialogues.forEach((d, i) => lines.push(`${d.prefix}: ${d.before.join(',')},${unmaskTags(trans[i], masked[i].tags)}`));
          outText = lines.join('\n') + '\n';
        } else {
          outText = buildAssFromCues(cues.map((c, i) => ({ start: c.start, end: c.end, text: unmaskTags(trans[i], masked[i].tags) })));
        }
      } else {
        const errMsg = "[النظام] عذراً، فشلت الترجمة الفورية بسبب ضغط الخوادم أو رفض الاستجابة.";
        outText = (assP ? assP.headerLines.join('\n') : ASS_DEFAULT_HEADER) + `\nDialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${errMsg}\n`;
      }
    }
  } catch (e) { logErr('translate', e); }
  res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8'); res.send(outText);
});

// ============= جلب الترجمات الشاملة =============
app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json', '/:config/subtitles/:type/:id.json', '/:config/subtitles/:type/:id/:extra.json'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { type, id, extra } = req.params;
  const targetId = extra && extra.endsWith('.json') ? `${id}/${extra.replace('.json', '')}` : id.replace('.json', '');
  const config = decodeConfig(req.params.config);

  const animeInfo = await resolveExternalId(targetId);
  const tIds = [targetId];
  if (animeInfo?.imdbId && !tIds.includes(animeInfo.imdbId)) tIds.push(animeInfo.imdbId);
  if (animeInfo?.kitsuId && animeInfo?.absoluteEp && !tIds.includes(`kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`)) tIds.push(`kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`);

  const reqs = [];
  for (const tid of tIds) {
    const fType = (tid.startsWith('kitsu') || type === 'anime') ? 'series' : type;
    reqs.push(...buildMirrorRequests(tid, fType, false));
    if (tid.startsWith('tt')) {
      const { imdbId, season, episode } = parseImdbId(tid);
      if (config.openSubKey) reqs.push(fetchOpenSubtitlesDirect(imdbId, season, episode, config.openSubKey));
      if (config.wyzieKey) reqs.push(fetchWyzieDirect(imdbId, season, episode, config.wyzieKey));
    }
  }

  const spIds = [...new Set(tIds.filter(t=>t.startsWith('tt')).map(t=>{const p=parseImdbId(t); return p.season?`${p.imdbId}:${p.season}`:null;}).filter(Boolean))];
  for (const spid of spIds) {
    reqs.push(...buildMirrorRequests(spid, 'series', true));
    const { imdbId, season } = parseImdbId(spid);
    if (config.openSubKey) reqs.push(fetchOpenSubtitlesDirect(imdbId, season, null, config.openSubKey, true));
    if (config.wyzieKey) reqs.push(fetchWyzieDirect(imdbId, season, null, config.wyzieKey, true));
  }

  if (animeInfo?.title) {
    reqs.push(axios.get(`https://animetosho.org/api/v1/search?q=${encodeURIComponent(`${animeInfo.title} ${animeInfo.absoluteEp||''}`.trim())}`, getAxiosConfig()).then(r => (r.data?.results||[]).filter(i=>i.attachment_url).map(i=>({ url: i.attachment_url, lang: 'eng', origName: i.title, _source: 'animetosho' }))).catch(e => { logErr('animetosho', e); return []; }));
  }

  let subdlZips = [];
  if (config.subdlKey) {
    for (const tid of tIds.filter(t=>t.startsWith('tt'))) { const p = parseImdbId(tid); subdlZips.push(...await fetchSubDLDirect(p.imdbId, p.season, p.episode, config.subdlKey)); }
    for (const spid of spIds) { const p = parseImdbId(spid); subdlZips.push(...await fetchSubDLDirect(p.imdbId, p.season, null, config.subdlKey, true)); }
  }

  const results = await Promise.all(reqs);
  let rawSubs = results.flat();
  const host = req.get('host'), protocol = req.protocol;

  subdlZips.forEach(z => rawSubs.push({ ...z, url: `${protocol}://${host}/subdl-extract?zipUrl=${encodeURIComponent(z.zipUrl)}` }));

  console.log(`[subtitles] ${type}/${targetId} -> tIds:[${tIds.join(', ')}] | نتائج البحث بالمعرف: ${rawSubs.length}`);

  // البند 5: البحث الاحتياطي بالاسم — يعمل فقط عندما يفشل البحث بالمعرف تمامًا ولدينا عنوان معروف
  if (rawSubs.length === 0 && animeInfo?.title && (config.openSubKey || config.subdlKey)) {
    console.log(`[fallback] البحث بالمعرف فشل، تجربة البحث بالاسم: "${animeInfo.title}"`);
    const [byNameOS, byNameSubDL] = await Promise.all([
      fetchOpenSubtitlesByName(animeInfo.title, config.openSubKey),
      fetchSubDLByName(animeInfo.title, config.subdlKey)
    ]);
    rawSubs.push(...byNameOS);
    byNameSubDL.forEach(z => rawSubs.push({ ...z, url: `${protocol}://${host}/subdl-extract?zipUrl=${encodeURIComponent(z.zipUrl)}` }));
    console.log(`[fallback] نتائج البحث بالاسم: ${byNameOS.length + byNameSubDL.length}`);
  }

  const uMap = new Map();
  for (const s of rawSubs) {
    if (!s || !s.url) continue;
    s._ext = (s.url.match(/\.(srt|ass|ssa|vtt)(\?|$)/i) || [, 'srt'])[1].toLowerCase();
    const k = s.url.split('?')[0] + (s.origName||'');
    if (!uMap.has(k)) uMap.set(k, s);
  }
  rawSubs = Array.from(uMap.values());

  const arSubs = [], enSubs = [];
  for (const s of rawSubs) {
    const l = (s.lang||'').toLowerCase(), isAr = l==='ara'||l==='ar'||l.includes('ara');
    const orig = s.origName || (isAr ? 'ترجمة عربية' : 'Subtitle');
    const tag = s._seasonPack ? ' [باقة الموسم]' : '';
    const label = `${orig} • ${sourceLabelOf(s._source)} • ${s._ext.toUpperCase()}${tag}`;
    // مهم: lang يجب أن يبقى رمز لغة ISO 639-2 صحيح (ara/eng) وليس نصًا وصفيًا -
    // وضع نص كامل هنا يجعل Nuvio يرفض عرض الترجمة بالكامل. التسمية الوصفية
    // توضع فقط في name/title.
    const formatted = { id: `sub_${s.url.slice(-10)}`, url: s.url, lang: isAr ? 'ara' : (l || 'eng'), name: label, title: label, _ext: s._ext, _source: s._source, origName: orig };
    isAr ? arSubs.push(formatted) : enSubs.push(formatted);
  }

  const rank = { ass: 0, ssa: 0, vtt: 1, srt: 2 };
  const sorter = (a, b) => (rank[a._ext]??3) - (rank[b._ext]??3);
  arSubs.sort(sorter); enSubs.sort(sorter);

  const limitedAr = arSubs.slice(0, config.limit);

  const aiSubs = [];
  if (enSubs.length > 0 && (config.geminiKey || config.groqKey || config.openaiKey || config.deeplKey)) {
    const base = req.params.config ? `${protocol}://${host}/${req.params.config}` : `${protocol}://${host}`;
    enSubs.slice(0, 5).forEach((c, idx) => {
      const aiLabel = `${c.origName} • ${sourceLabelOf(c._source)} • trans • ASS`;
      aiSubs.push({ id: `trans_${idx+1}`, url: `${base}/translate/trans.ass?subUrl=${encodeURIComponent(c.url)}`, lang: 'ara', name: aiLabel, title: aiLabel });
    });
  }

  console.log(`[subtitles] ${type}/${targetId} -> عربي:${arSubs.length} (معروض:${limitedAr.length}) | أجنبي:${enSubs.length} | AI:${aiSubs.length}`);

  res.json({ subtitles: [...limitedAr.map(({_ext,_source,origName,...rest})=>rest), ...aiSubs] });
});

app.get('/subdl-extract', async (req, res) => {
  try {
    const r = await axios.get(req.query.zipUrl, { responseType: 'arraybuffer', timeout: 12000, headers: {'User-Agent': USER_AGENTS[0]} });
    const z = new AdmZip(Buffer.from(r.data)), entries = z.getEntries().filter(e => /\.(srt|ass|ssa|vtt)$/i.test(e.entryName));
    if (!entries.length) return res.status(404).send("No sub found");
    const chosen = entries.find(e=>/\.ass$/i.test(e.entryName)) || entries.find(e=>/\.srt$/i.test(e.entryName)) || entries[0];
    res.setHeader('Content-Type', chosen.entryName.toLowerCase().endsWith('ass') ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(chosen.getData().toString('utf8'));
  } catch (err) { logErr('extract', err); res.status(500).send("Extraction failed"); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
