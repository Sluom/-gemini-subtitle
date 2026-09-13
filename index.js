const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const zlib = require('zlib');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.gemini.subtitles",
  version: "28.0.0",
  name: "Universal Subtitles & Gemini AI",
  description: "جلب كافة الترجمات الشاملة المباشرة مع ترجمة فورية عربية فائقة السرعة عبر Groq و Gemini",
  logo: "https://raw.githubusercontent.com/Sluom/-gemini-subtitle/main/logo.png",
  resources: [{ name: "subtitles", types: ["anime", "series", "movie", "other"], idPrefixes: ["kitsu", "mal", "anilist", "tt"] }],
  types: ["anime", "series", "movie", "other"],
  idPrefixes: ["kitsu", "mal", "anilist", "tt"],
  catalogs: []
};

// ============= تدوير وكلاء المستخدم والاتصال =============
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];
function getRandomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function getAxiosConfig(extraHeaders = {}) {
  return { headers: { 'User-Agent': getRandomUA(), 'Accept': '*/*', ...extraHeaders }, timeout: 12000 };
}

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
  console.error(`[${label}] خطأ:`, err?.response?.status || err?.message || err);
}

function slugify(str) {
  return (str || 'sub').toString().normalize('NFKD')
    .replace(/[^\w\u0600-\u06FF\- ]/g, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'sub';
}

function safeDecodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return iconv.decode(buf, 'win1256'); }
    catch (e2) { return buf.toString('utf8'); }
  }
}

function cleanJsonText(raw) {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1);
  }
  return s;
}

function decodeConfig(token) {
  const keys = { geminiKey: '', groqKey: '', deeplKey: '', openaiKey: '', jimakuKey: '', subsourceKey: '', openSubKey: '', subdlKey: '', wyzieKey: '', limit: 100 };
  if (!token) return keys;
  try {
    const p = JSON.parse(base64UrlDecode(token));
    Object.keys(keys).forEach(k => { if (p[k] !== undefined) keys[k] = k === 'limit' ? parseInt(p[k]) : p[k]; });
  } catch (e) { logErr('config:decode', e); }
  return keys;
}

const SOURCE_LABELS = {
  'opensub-v3': 'OpenSubtitles', 'opensub-fun': 'OpenSubtitles', 'opensub-official': 'OpenSubtitles (VIP)',
  'subdl-mirror': 'SubDL', 'subdl-official': 'SubDL', 'subdl-v2': 'SubDL (Subscene)', 'yify': 'YIFY',
  'anime-subs': 'AnimeSubs', 'kitsunekko': 'Kitsunekko', 'subanime': 'SubAnime', 'animetosho': 'AnimeTosho',
  'wyzie': 'Wyzie', 'subsource': 'SubSource', 'jimaku': 'Jimaku', 'gestdown': 'Addic7ed'
};
function sourceLabelOf(key) { return SOURCE_LABELS[key] || 'Source'; }

// ============= ذاكرة التخزين المؤقت للترجمات (Cache) =============
const translationCache = new Map();
function getCachedTranslation(key) { return translationCache.get(key); }
function setCachedTranslation(key, val) {
  if (translationCache.size > 60) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  translationCache.set(key, val);
}

// ============= طابور التنفيذ المحدود لتجنب 429 =============
async function runConcurrentPool(tasks, limit = 2) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try {
        results[current] = await tasks[current]();
      } catch (err) {
        results[current] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ============= بروكسي البث المباشر الموحّد =============
app.get(['/stream-sub', '/stream-sub/:filename'], async (req, res) => {
  const { url, ep } = req.query;
  if (!url) return res.status(400).send("No URL");

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: { 'User-Agent': getRandomUA(), 'Accept': '*/*' }
    });

    let buffer = Buffer.from(response.data);

    if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      try {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries().filter(e => /\.(srt|ass|ssa|vtt)$/i.test(e.entryName));
        if (entries.length > 0) {
          let chosen = entries[0];
          if (ep) {
            const epMatched = entries.filter(e => new RegExp(`(^|[^0-9])0*${ep}([^0-9]|$)`).test(e.entryName));
            if (epMatched.length) chosen = epMatched[0];
          }
          chosen = entries.find(e => /\.ass$/i.test(e.entryName)) || chosen;
          buffer = chosen.getData();
        }
      } catch (e) { logErr('stream:zip', e); }
    }

    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try { buffer = zlib.gunzipSync(buffer); } catch (e) {}
    }

    const decodedText = safeDecodeText(buffer);
    const filename = req.params.filename || '';
    const isAss = filename.endsWith('.ass') || filename.endsWith('.ssa') || decodedText.includes('[Script Info]');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    return res.send(decodedText);
  } catch (err) {
    logErr('stream-sub', err);
    return res.redirect(url);
  }
});

// ============= استخراج وبناء أسطر الترجمة =============
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

function extractCuesUniversal(text) {
  const assLines = text.split(/\r?\n/).filter(l => /^Dialogue:/i.test(l.trim()));
  if (assLines.length > 0) {
    const cues = [];
    for (const line of assLines) {
      const m = line.match(/^Dialogue:\s*[^,]*,([^,]*),([^,]*),(?:[^,]*,){6}(.*)$/i);
      if (m) cues.push({ start: m[1].trim(), end: m[2].trim(), text: m[3] });
    }
    if (cues.length) return cues;
  }
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

let activeGeminiModelPath = null;
async function resolveGeminiModel(key) {
  if (activeGeminiModelPath) return activeGeminiModelPath;
  try {
    const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { timeout: 5000 });
    const models = r.data?.models || [];
    const found = models.find(m => m.supportedGenerationMethods?.includes('generateContent') && (m.name.includes('flash') || m.name.includes('gemini')));
    if (found) {
      activeGeminiModelPath = found.name;
      return activeGeminiModelPath;
    }
  } catch (e) {}
  return 'models/gemini-2.0-flash';
}

// ============= محرك الترجمة الصارم بالتوازي المنظم =============
async function translateChunkStrict(texts, keys) {
  const prompt = `You are a professional subtitle translator. Target Language: ARABIC ONLY.
Translate the following JSON array of strings into natural, accurate Arabic.
Rules:
1. Return ONLY a raw JSON object with key "data" containing the translated Arabic strings array. Example: {"data": ["مرحبا", "أهلاً"]}.
2. Keep formatting and line breaks \\N intact.
3. NEVER output English.
Length: ${texts.length}.
Input: ${JSON.stringify(texts)}`;

  // الأولوية القصوى لـ Groq فائق السرعة
  if (keys.groqKey) {
    try {
      const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      }, { headers: { Authorization: `Bearer ${keys.groqKey.trim()}`, 'Content-Type': 'application/json' }, timeout: 12000 });
      const raw = cleanJsonText(r.data?.choices?.[0]?.message?.content);
      if (raw) {
        const parsed = JSON.parse(raw);
        const data = parsed.data || parsed.translations || parsed;
        if (Array.isArray(data) && data.length === texts.length) return data;
      }
    } catch (e) { logErr('trans:groq', e); }
  }

  // Gemini كخيار بديل
  if (keys.geminiKey) {
    try {
      const modelPath = await resolveGeminiModel(keys.geminiKey.trim());
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${encodeURIComponent(keys.geminiKey.trim())}`;
      const r = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json' }
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      const raw = cleanJsonText(r.data?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (raw) {
        const parsed = JSON.parse(raw);
        const data = parsed.data || parsed.translations || parsed;
        if (Array.isArray(data) && data.length === texts.length) return data;
      }
    } catch (e) { logErr('trans:gemini', e); }
  }

  // OpenAI كخيار إضافي
  if (keys.openaiKey) {
    try {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      }, { headers: { Authorization: `Bearer ${keys.openaiKey.trim()}` }, timeout: 15000 });
      const raw = cleanJsonText(r.data?.choices?.[0]?.message?.content);
      if (raw) {
        const parsed = JSON.parse(raw);
        const data = parsed.data || parsed;
        if (Array.isArray(data) && data.length === texts.length) return data;
      }
    } catch (e) { logErr('trans:openai', e); }
  }

  return null;
}

// مسار معالجة وترجمة الملف الفوري
app.get(['/translate', '/translate/:filename'], async (req, res) => {
  const { subUrl, geminiKey, groqKey, openaiKey, deeplKey } = req.query;
  if (!subUrl) return res.status(400).send("No Subtitle URL");

  const cacheKey = `${subUrl}_${groqKey ? 'groq' : 'gemini'}`;
  const cachedData = getCachedTranslation(cacheKey);
  if (cachedData) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
    return res.send(cachedData);
  }

  const keys = { geminiKey, groqKey, openaiKey, deeplKey };

  try {
    const r = await axios.get(subUrl, { responseType: 'arraybuffer', timeout: 10000, headers: { 'User-Agent': getRandomUA() } });
    const originalText = safeDecodeText(Buffer.from(r.data));
    const cues = extractCuesUniversal(originalText);

    if (!cues.length) {
      res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
      return res.send(ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[النظام] تعذر استخراج نصوص الترجمة المصدر.`);
    }

    // تقسيم النصوص إلى حزم من 80 سطراً (حوالي 6 إلى 8 حزم للحلقة)
    const CHUNK = 80;
    const chunks = [];
    for (let i = 0; i < cues.length; i += CHUNK) {
      chunks.push(cues.slice(i, i + CHUNK));
    }

    // إرسال حزمتين فقط بالتوازي (Concurrency = 2) لمنع حظر 429
    const tasks = chunks.map(chunk => async () => {
      const texts = chunk.map(c => c.text);
      const translated = await translateChunkStrict(texts, keys);
      return translated || texts; // في حال تعثر حزمة، لا نمسح النص بنقاط
    });

    const chunkResults = await runConcurrentPool(tasks, 2);
    const finalTranslations = chunkResults.flat();
    const assLines = cues.map((c, idx) => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${finalTranslations[idx] || c.text}`);

    const finalAssOutput = ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';
    setCachedTranslation(cacheKey, finalAssOutput);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
    return res.send(finalAssOutput);
  } catch (err) {
    logErr('translate-route', err);
    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
    return res.send(ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[النظام] تعثرت الترجمة الفورية.`);
  }
});

// ============= دوال جلب الترجمات الشاملة =============
async function fetchOpenSubtitlesDirect(imdbId, season, episode, apiKey) {
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
        if (dl.data?.link) {
          out.push({
            url: dl.data.link,
            lang: item.attributes.language || 'ara',
            origName: item.attributes.release || item.attributes.files?.[0]?.file_name || 'OpenSubtitles',
            _source: 'opensub-official'
          });
        }
      } catch (e) {}
    }
    return out;
  } catch (e) { logErr('opensubDirect', e); return []; }
}

async function fetchSubDLv2(params, apiKey) {
  if (!apiKey) return [];
  try {
    const qs = new URLSearchParams({ ...params, languages: 'ar,en', unpack: '1' });
    const r = await axios.get(`https://api.subdl.com/api/v2/subtitles/search?${qs.toString()}`, getAxiosConfig({ Authorization: `Bearer ${apiKey.trim()}` }));
    const subs = r.data?.subtitles || r.data?.results || [];
    return subs.filter(s => s && (s.url || s.download_url || s.file_url)).map(s => ({
      url: s.url || s.download_url || s.file_url,
      lang: (s.lang || s.language || 'ara').toLowerCase(),
      origName: s.release_name || s.name || 'SubDL',
      _source: 'subdl-v2'
    }));
  } catch (e) { logErr('subdlV2', e); return []; }
}

async function fetchSubDLDirectZip(imdbId, season, episode, apiKey) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ api_key: apiKey.trim(), imdb_id: imdbId, languages: 'AR,EN' });
    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, getAxiosConfig());
    return (r.data?.subtitles || []).filter(item => item.url).map(item => ({
      url: item.url.startsWith('http') ? item.url : `https://dl.subdl.com${item.url}`,
      lang: (item.lang || 'ara').toLowerCase(),
      origName: item.release_name || item.name || 'SubDL Zip',
      _source: 'subdl-official',
      _isZip: true
    }));
  } catch (e) { logErr('subdlZip', e); return []; }
}

async function fetchSubSourceDirect(title, apiKey) {
  if (!apiKey || !title) return [];
  try {
    const search = await axios.get(`https://api.subsource.net/api/v1/movies/search?query=${encodeURIComponent(title)}`, getAxiosConfig({ 'X-API-Key': apiKey.trim() }));
    const movieId = search.data?.data?.[0]?.movieId || search.data?.movies?.[0]?.id;
    if (!movieId) return [];

    const subsRes = await axios.get(`https://api.subsource.net/api/v1/subtitles?movieId=${movieId}&language=arabic&sort=newest&limit=30`, getAxiosConfig({ 'X-API-Key': apiKey.trim() }));
    const subs = subsRes.data?.data || [];
    const out = [];

    for (const s of subs.slice(0, 15)) {
      try {
        const dl = await axios.get(`https://api.subsource.net/api/v1/subtitles/${s.subtitleId}/download`, getAxiosConfig({ 'X-API-Key': apiKey.trim() }));
        const link = dl.data?.link || dl.data?.url || dl.data?.downloadUrl;
        if (link) {
          out.push({
            url: link,
            lang: 'ara',
            origName: Array.isArray(s.releaseInfo) ? s.releaseInfo.join(' ') : (s.releaseInfo || 'SubSource'),
            _source: 'subsource'
          });
        }
      } catch (e) {}
    }
    return out;
  } catch (e) { logErr('subsource', e); return []; }
}

async function fetchJimakuDirect(anilistId, episode, apiKey) {
  if (!apiKey || !anilistId) return [];
  try {
    const s = await axios.get(`https://jimaku.cc/api/entries/search?anilist_id=${anilistId}`, getAxiosConfig({ 'Authorization': apiKey.trim() }));
    const entryId = s.data?.[0]?.id;
    if (!entryId) return [];

    const f = await axios.get(`https://jimaku.cc/api/entries/${entryId}/files`, getAxiosConfig({ 'Authorization': apiKey.trim() }));
    const files = (Array.isArray(f.data) ? f.data : []).filter(file => /\.(ass|ssa|srt|vtt|zip)$/i.test(file.name || file.url || ''));

    return files.map(file => ({
      url: file.url,
      lang: 'ara',
      origName: file.name || 'Jimaku Anime Sub',
      _source: 'jimaku',
      _isZip: /\.zip$/i.test(file.name || file.url)
    }));
  } catch (e) { logErr('jimaku', e); return []; }
}

function mirrorRequest(url, sourceKey) {
  return axios.get(url, getAxiosConfig())
    .then(r => (r.data?.subtitles || []).map(s => ({
      url: s.url,
      lang: s.lang || 'ara',
      origName: s.title || s.SubFileName || s.name || sourceKey,
      _source: sourceKey
    })))
    .catch(() => []);
}

// ============= مسار فحص المفاتيح =============
app.post('/test-key', async (req, res) => {
  const { provider, key } = req.body;
  if (!key) return res.json({ success: false, message: "يرجى إدخال المفتاح أولاً ⚠️" });
  const cleanKey = key.trim();
  try {
    if (provider === 'gemini') {
      const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`, { timeout: 7000 });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح Gemini صالح 100% ✅" });
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
      if (r.status === 200) return res.json({ success: true, message: "مفتاح OpenSubtitles صالح 100% ✅" });
    }
    if (provider === 'subdl') {
      const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${cleanKey}&film_name=Inception`, { timeout: 5000 });
      if (r.data?.status === true || r.data?.results) return res.json({ success: true, message: "مفتاح SubDL صالح 100% ✅" });
    }
    if (provider === 'subsource') {
      const r = await axios.get('https://api.subsource.net/api/v1/movies/search?query=Inception', getAxiosConfig({ 'X-API-Key': cleanKey })).catch(e => e.response);
      if (r && (r.status === 200 || r.status === 404)) return res.json({ success: true, message: "مفتاح SubSource صالح 100% ✅" });
    }
    if (provider === 'jimaku') return res.json({ success: true, message: "مفتاح Jimaku صالح ومحفوظ ✅" });
    if (provider === 'wyzie') return res.json({ success: true, message: "مفتاح Wyzie صالح ومحفوظ ✅" });

    return res.json({ success: false, message: "المفتاح غير صالح ❌" });
  } catch (err) {
    return res.json({ success: false, message: "فشل الفحص: تأكد من صحة المفتاح ❌" });
  }
});

// ============= واجهة التخصيص =============
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
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Universal Subtitles & Gemini AI</h2>

        <h3>🤖 محركات الذكاء الاصطناعي (للترجمة الفورية)</h3>
        <div class="field-group">
          <div class="label-row"><label>مفتاح Google Gemini API:</label><a class="get-link" href="https://aistudio.google.com/app/apikey" target="_blank">🔗 احصل على المفتاح</a></div>
          <div class="input-row"><input type="text" id="geminiKey" placeholder="AIzaSy..."><button class="btn-test" onclick="testKey('gemini', 'geminiKey', 'msgGemini')">فحص</button></div>
          <div id="msgGemini" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row"><label>مفتاح Groq API (فائق السرعة وموصى به):</label><a class="get-link" href="https://console.groq.com/keys" target="_blank">🔗 احصل على المفتاح</a></div>
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

        <h3>🎌 مواقع ومصادر ترجمات الأنمي</h3>
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
          <label>الحد الأقصى لنتائج الترجمة:</label>
          <select id="limit">
            <option value="30">30 نتيجة (سريع)</option>
            <option value="60" selected>60 نتيجة (شامل ومثالي)</option>
            <option value="150">150 نتيجة (جلب الكل بلا استثناء)</option>
          </select>
        </div>

        <button class="btn-install" onclick="install()">تثبيت / تحديث في Nuvio</button>
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
        function install() {
          const config = toBase64Url(JSON.stringify({
            geminiKey: document.getElementById('geminiKey').value.trim(), groqKey: document.getElementById('groqKey').value.trim(),
            deeplKey: document.getElementById('deeplKey').value.trim(), openaiKey: document.getElementById('openaiKey').value.trim(),
            jimakuKey: document.getElementById('jimakuKey').value.trim(), subsourceKey: document.getElementById('subsourceKey').value.trim(),
            openSubKey: document.getElementById('openSubKey').value.trim(), subdlKey: document.getElementById('subdlKey').value.trim(),
            wyzieKey: document.getElementById('wyzieKey').value.trim(), limit: document.getElementById('limit').value
          }));
          window.location.href = 'nuvio://' + window.location.origin.replace(/^https?:\\/\\//, '') + '/' + config + '/manifest.json';
        }
      </script>
    </body>
    </html>
  `);
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => res.json(manifest));

// ============= المعالج الرئيسي لجلب كافة الروابط =============
app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json', '/:config/subtitles/:type/:id.json', '/:config/subtitles/:type/:id/:extra.json'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { type, id, extra } = req.params;
  const targetId = extra && extra.endsWith('.json') ? `${id}/${extra.replace('.json', '')}` : id.replace('.json', '');
  const config = decodeConfig(req.params.config);

  const tIds = [targetId];
  const { imdbId, season, episode } = parseImdbId(targetId);

  const reqs = [];

  // مرايا Stremio العامة
  reqs.push(
    mirrorRequest(`https://opensubtitles-v3.strem.io/subtitles/${type}/${targetId}.json`, 'opensub-v3'),
    mirrorRequest(`https://opensubtitles.strem.fun/subtitles/${type}/${targetId}.json`, 'opensub-fun'),
    mirrorRequest(`https://subdl-stremio.vercel.app/subtitles/${type}/${targetId}.json`, 'subdl-mirror'),
    mirrorRequest(`https://yifysubtitles.strem.fun/subtitles/${type}/${targetId}.json`, 'yify')
  );

  // مصادر الأنمي
  if (targetId.startsWith('kitsu') || targetId.startsWith('anilist') || targetId.startsWith('mal') || type === 'anime' || type === 'series') {
    reqs.push(
      mirrorRequest(`https://anime-subtitles.strem.fun/subtitles/series/${targetId}.json`, 'anime-subs'),
      mirrorRequest(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${targetId}.json`, 'kitsunekko')
    );
  }

  // OpenSubtitles API
  if (config.openSubKey && imdbId.startsWith('tt')) {
    reqs.push(fetchOpenSubtitlesDirect(imdbId, season, episode, config.openSubKey));
  }

  // SubDL (v1 Zips & v2 Unpacked)
  if (config.subdlKey && imdbId.startsWith('tt')) {
    reqs.push(
      fetchSubDLDirectZip(imdbId, season, episode, config.subdlKey),
      fetchSubDLv2({ imdb_id: imdbId, season, episode }, config.subdlKey)
    );
  }

  // SubSource API
  if (config.subsourceKey) {
    reqs.push(fetchSubSourceDirect(imdbId, config.subsourceKey));
  }

  // Jimaku
  if (config.jimakuKey && (targetId.startsWith('anilist') || targetId.startsWith('kitsu'))) {
    reqs.push(fetchJimakuDirect(targetId.split(':')[1], episode, config.jimakuKey));
  }

  const results = await Promise.all(reqs);
  let rawSubs = results.flat().filter(s => s && s.url && typeof s.url === 'string');

  const host = req.get('host');
  const protocol = req.protocol;

  const seenUrls = new Set();
  const allFormattedSubs = [];
  const nonArabicSubs = [];

  for (const s of rawSubs) {
    if (seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);

    const extMatch = s.url.match(/\.(ass|ssa|srt|vtt)(\?|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : (s._isZip ? 'ass' : 'srt');

    const cleanStreamUrl = `${protocol}://${host}/stream-sub/${slugify(s.origName)}.${ext}?url=${encodeURIComponent(s.url)}`;

    const l = (s.lang || '').toLowerCase();
    const isAr = l === 'ara' || l === 'ar' || l === 'arabic' || l.includes('ara');

    const trackLabel = `${s.origName || 'ترجمة'} • ${sourceLabelOf(s._source)} • ${ext.toUpperCase()}`;

    const formattedTrack = {
      id: `universal_${s._source || 'sub'}_${ext}_${allFormattedSubs.length + 1}`,
      url: cleanStreamUrl,
      lang: isAr ? 'ara' : (l || 'eng'),
      name: trackLabel,
      title: trackLabel
    };

    if (isAr) {
      allFormattedSubs.push(formattedTrack);
    } else {
      nonArabicSubs.push({ ...formattedTrack, rawUrl: s.url, ext });
    }
  }

  allFormattedSubs.sort((a, b) => {
    const isAAss = a.name.includes('ASS');
    const isBAss = b.name.includes('ASS');
    return isBAss - isAAss;
  });

  // إضافة حتى 5 ترجمات AI موجهة بدقة إلى العربية
  const hasAiKey = config.geminiKey || config.groqKey || config.deeplKey || config.openaiKey;
  if (nonArabicSubs.length > 0 && hasAiKey) {
    const aiCandidates = nonArabicSubs.slice(0, 5);
    aiCandidates.forEach((c, idx) => {
      const aiUrl = `${protocol}://${host}/translate/${slugify(c.name)}-ai.ass?subUrl=${encodeURIComponent(c.rawUrl)}&geminiKey=${encodeURIComponent(config.geminiKey)}&groqKey=${encodeURIComponent(config.groqKey)}&openaiKey=${encodeURIComponent(config.openaiKey)}`;
      allFormattedSubs.push({
        id: `universal_ai_trans_${idx + 1}`,
        url: aiUrl,
        lang: 'ara',
        name: `[AI الفورية 🇸🇦] ${c.name}`,
        title: `[AI الفورية 🇸🇦] ${c.name}`
      });
    });
  }

  const finalResults = allFormattedSubs.slice(0, config.limit);
  return res.json({ subtitles: finalResults });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
