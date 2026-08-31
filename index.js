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
  version: "26.3.0",
  name: "Universal Subtitles & Gemini AI (Pro)",
  description: "جلب الترجمات الشاملة (ASS/SRT) المباشرة للأنمي والأفلام مع الترجمة الفورية بالذكاء الاصطناعي",
  resources: [
    {
      name: "subtitles",
      types: ["movie", "series", "anime", "other"],
      idPrefixes: ["tt", "kitsu", "mal", "anilist"] // تمت إزالة TMDB/TVDB لعدم الحاجة
    }
  ],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "kitsu", "mal", "anilist"],
  catalogs: []
};

// ============= 15. التدوير الذكي لوكلاء المستخدم (User-Agent Rotation) =============
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/113.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
];
function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
function getAxiosConfig(extraHeaders = {}) {
  return { headers: { 'User-Agent': getRandomUA(), 'Accept': 'application/json', ...extraHeaders }, timeout: 7000 };
}

// ============= أدوات مساعدة عامة =============
function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function parseImdbId(rawId) {
  const parts = rawId.split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1]) : null,
    episode: parts[2] ? parseInt(parts[2]) : null
  };
}

function logErr(label, err) {
  const msg = err?.response?.status ? `HTTP ${err.response.status}` : err?.message || err;
  console.error(`[${label}] فشل:`, msg);
}

// 10. و 13. فك تشفير الإعدادات (مع إزالة TMDB وإضافة Limit)
function decodeConfig(token) {
  const keys = {
    geminiKey: '', groqKey: '', deeplKey: '', openaiKey: '',
    subsourceKey: '', openSubKey: '', subdlKey: '', wyzieKey: '', limit: 50
  };
  if (!token) return keys;
  try {
    const p = JSON.parse(base64UrlDecode(token));
    Object.keys(keys).forEach(k => { 
      if (p[k] !== undefined) keys[k] = k === 'limit' ? parseInt(p[k]) : p[k]; 
    });
  } catch (e) { logErr('config:decode', e); }
  return keys;
}

const SOURCE_LABELS = {
  'opensub-v3': 'OpenSub',
  'opensub-fun': 'OpenSub',
  'opensub-official': 'OpenSub',
  'subdl-mirror': 'SubDL',
  'subdl-official': 'SubDL',
  'yify': 'YIFY',
  'anime-subs': 'AnimeSubs',
  'kitsunekko': 'Kitsunekko',
  'subanime': 'SubAnime',
  'animetosho': 'AnimeTosho',
  'wyzie': 'Wyzie',
  'subsource': 'SubSource'
};
function sourceLabelOf(key) { return SOURCE_LABELS[key] || 'Source'; }

// ============= 9. حماية هندسة ASS و Masking =============
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
  const h = parseInt(m[1], 10);
  const cs = Math.floor(parseInt(m[4], 10) / 10).toString().padStart(2, '0');
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
    const text2 = lines.slice(idx + 1).join('\n');
    if (!text2.trim()) continue;
    cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), text: text2 });
  }
  return cues;
}

function buildAssFromCues(cues) {
  const lines = cues.map(c => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${String(c.text).replace(/\n/g, '\\N')}`);
  return ASS_DEFAULT_HEADER + lines.join('\n') + '\n';
}

function parseAss(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const eventsIdx = lines.findIndex(l => l.trim().toLowerCase() === '[events]');
  if (eventsIdx === -1) return null;
  let formatIdx = lines.findIndex((l, i) => i > eventsIdx && /^Format:/i.test(l.trim()));
  if (formatIdx === -1) return null;
  const fields = lines[formatIdx].split(':').slice(1).join(':').split(',').map(s => s.trim());
  
  const headerLines = lines.slice(0, formatIdx + 1);
  const dialogues = [];
  for (let i = formatIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const prefixMatch = line.match(/^(Dialogue|Comment):\s*/i);
    if (!prefixMatch) continue;
    const parts = line.slice(prefixMatch[0].length).split(',');
    const before = parts.slice(0, fields.length - 1);
    const textPart = parts.slice(fields.length - 1).join(',');
    dialogues.push({ prefix: prefixMatch[1], before, text: textPart });
  }
  return { headerLines, dialogues };
}

// نظام إخفاء التاجات
function maskTags(text) {
  let tags = [];
  let masked = text.replace(/\{[^}]+\}/g, (match) => {
    tags.push(match);
    return `[T${tags.length - 1}]`;
  });
  return { masked, tags };
}

function unmaskTags(text, tags) {
  let unmasked = text;
  tags.forEach((tag, i) => {
    unmasked = unmasked.replace(new RegExp(`\\[T${i}\\]`, 'g'), tag);
  });
  return unmasked;
}

// ============= 8. الترجمة الصارمة ومنع الفشل الصامت =============
async function translateChunkJSON(texts, provider, key) {
  const prompt = `You are a professional subtitle translator. Target Language: ARABIC ONLY.
Task: Translate the following JSON array of strings into Arabic. 
Rules:
1. MUST return a raw JSON object with a single key "data" containing an array of the translated strings. Example: {"data": ["مرحبا", "كيف حالك"]}.
2. Keep any tags like [T0], \\N exactly where they are.
3. NEVER return English text. If you don't know, translate literally.
Input length: ${texts.length} lines.
Input: ${JSON.stringify(texts)}`;

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key.trim())}`;
      const r = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: 'application/json' } }, getAxiosConfig({'Content-Type': 'application/json'}));
      const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) { const arr = JSON.parse(raw); return arr.data || arr; }
    }
    if (provider === 'groq' || provider === 'openai') {
      const isGroq = provider === 'groq';
      const url = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
      const r = await axios.post(url, { model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }, getAxiosConfig({ Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' }));
      let raw = r.data?.choices?.[0]?.message?.content;
      if (raw) { const arr = JSON.parse(raw); return arr.data || arr.translations || null; }
    }
  } catch (e) { logErr(`translateChunk:${provider}`, e); }
  return null;
}

async function translateTextArray(texts, keys) {
  if (!texts.length) return null;
  const providers = [];
  if (keys.geminiKey) providers.push({ name: 'gemini', key: keys.geminiKey });
  if (keys.groqKey) providers.push({ name: 'groq', key: keys.groqKey });
  if (keys.openaiKey) providers.push({ name: 'openai', key: keys.openaiKey });
  if (!providers.length) return null;

  const CHUNK = 80; // تقليل الدفعة لزيادة دقة النماذج
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    let done = null;
    for (const p of providers) {
      done = await translateChunkJSON(chunk, p.name, p.key);
      if (done && Array.isArray(done) && done.length === chunk.length) break;
      done = null; // فشل المحرك أو نقص العدد
    }
    if (!done) return null; // الخطة الأساسية فشلت تماماً
    results.push(...done);
  }
  return results;
}

// ============= 3. و 4. الجسر المزدوج ونظام التخزين المؤقت =============
let animeListCache = null;
let animeListCacheTime = 0;
const idResolveCache = new Map(); // التخزين المؤقت للتحويلات

async function getAnimeListMap() {
  const now = Date.now();
  if (animeListCache && now - animeListCacheTime < 24 * 3600 * 1000) return animeListCache;
  try {
    const r = await axios.get('https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json', getAxiosConfig());
    if (Array.isArray(r.data)) { animeListCache = r.data; animeListCacheTime = now; }
    return animeListCache || [];
  } catch (e) { logErr('animeListMap:fetch', e); return animeListCache || []; }
}

async function resolveExternalId(rawId) {
  if (idResolveCache.has(rawId)) return idResolveCache.get(rawId);
  try {
    const parts = rawId.split(':');
    const prefix = parts[0];
    const map = await getAnimeListMap();
    let result = { imdbId: null, kitsuId: null, absoluteEp: null, title: null, isMovie: false };

    if (prefix === 'kitsu' || prefix === 'mal' || prefix === 'anilist') {
      const extId = parts[1];
      result.absoluteEp = parts[2] ? parseInt(parts[2]) : null;
      if (!result.absoluteEp) result.isMovie = true; // 6. معالجة أفلام الأنمي
      
      const field = prefix === 'kitsu' ? 'kitsu_id' : prefix === 'mal' ? 'mal_id' : 'anilist_id';
      const entry = map.find(e => String(e[field]) === String(extId));
      result.kitsuId = entry?.kitsu_id || (prefix === 'kitsu' ? extId : null);
      
      if (prefix === 'kitsu') {
        const res = await axios.get(`https://kitsu.io/api/edge/anime/${extId}`, getAxiosConfig()).catch(()=>null);
        result.title = res?.data?.data?.attributes?.canonicalTitle || null;
      }
      
      if (entry && entry.imdb_id && !result.isMovie) {
        const iId = Array.isArray(entry.imdb_id) ? entry.imdb_id[0] : String(entry.imdb_id).split(',')[0].trim();
        const season = entry.season?.tvdb ?? 1;
        const ep = result.absoluteEp + (entry.episode_offset?.tvdb ?? 0);
        result.imdbId = `${iId}:${season}:${ep}`;
      } else if (entry && entry.imdb_id && result.isMovie) {
        result.imdbId = Array.isArray(entry.imdb_id) ? entry.imdb_id[0] : String(entry.imdb_id).split(',')[0].trim();
      }
    } 
    else if (prefix === 'tt') {
      const extId = parts[0];
      const season = parts[1] ? parseInt(parts[1]) : null;
      const episode = parts[2] ? parseInt(parts[2]) : null;
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

// ============= جلب الترجمات (2. بدون فحص صارم) =============
function mirrorRequest(url, sourceKey, seasonPack) {
  return axios.get(url, getAxiosConfig())
    .then(r => (r.data?.subtitles || []).map(s => ({
      url: s.url, lang: s.lang, origName: s.title || s.SubFileName || s.release || s.name || null, _source: sourceKey, _seasonPack: !!seasonPack
    }))).catch(() => []);
}

function buildMirrorRequests(tid, fetchType, seasonPack = false) {
  const reqs = [
    mirrorRequest(`https://opensubtitles-v3.strem.io/subtitles/${fetchType}/${tid}.json`, 'opensub-v3', seasonPack),
    mirrorRequest(`https://opensubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, 'opensub-fun', seasonPack),
    mirrorRequest(`https://subdl-stremio.vercel.app/subtitles/${fetchType}/${tid}.json`, 'subdl-mirror', seasonPack),
    mirrorRequest(`https://yifysubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, 'yify', seasonPack)
  ]; // 7. حذف Subscene
  if (tid.startsWith('kitsu') || tid.startsWith('anilist') || tid.startsWith('mal') || fetchType === 'series') {
    reqs.push(
      mirrorRequest(`https://anime-subtitles.strem.fun/subtitles/series/${tid}.json`, 'anime-subs', seasonPack),
      mirrorRequest(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${tid}.json`, 'kitsunekko', seasonPack)
    );
  }
  return reqs;
}

// ============= واجهة التخصيص =============
app.get(['/', '/configure'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Nuvio Subtitles Pro</title>
    <style>
      body { font-family: system-ui; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; padding: 20px; }
      .card { background: #1e293b; padding: 25px; border-radius: 16px; width: 100%; max-width: 530px; border: 1px solid #334155; }
      h2 { color: #38bdf8; text-align: center; }
      label { font-size: 13px; color: #cbd5e1; }
      input, select { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 15px;}
      .btn { width: 100%; padding: 14px; border-radius: 8px; border: none; background: #0284c7; color: #fff; font-weight: bold; cursor: pointer; }
    </style></head>
    <body>
      <div class="card">
        <h2>إعدادات Universal Subtitles</h2>
        <label>مفتاح Gemini API (للترجمة):</label><input type="text" id="geminiKey">
        <label>مفتاح Groq API:</label><input type="text" id="groqKey">
        <label>الحد الأقصى لنتائج الترجمات (باستثناء AI الثابتة بـ 5):</label>
        <select id="limit">
          <option value="10">10 نتائج (للأجهزة الضعيفة)</option>
          <option value="25">25 نتيجة</option>
          <option value="50" selected>50 نتيجة (مستحسن)</option>
          <option value="100">100 نتيجة</option>
        </select>
        <button class="btn" onclick="install()">تثبيت في Nuvio</button>
      </div>
      <script>
        function toBase64Url(str) { return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }
        function install() {
          const config = toBase64Url(JSON.stringify({
            geminiKey: document.getElementById('geminiKey').value.trim(),
            groqKey: document.getElementById('groqKey').value.trim(),
            limit: document.getElementById('limit').value
          }));
          window.location.href = 'nuvio://' + (window.location.origin + '/' + config + '/manifest.json').replace(/^https?:\\/\\//, '');
        }
      </script>
    </body>
    </html>
  `);
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => res.json(manifest));

// ============= الترجمة الفورية =============
app.get(['/translate', '/translate/:label', '/:config/translate', '/:config/translate/:label'], async (req, res) => {
  const { subUrl } = req.query;
  if (!subUrl) return res.status(400).send("No subtitle URL");
  const keys = req.params.config ? decodeConfig(req.params.config) : req.query;

  let originalText;
  try {
    const subRes = await axios.get(subUrl, { responseType: 'arraybuffer', timeout: 12000 });
    // 14. إصلاح الترميز (Encoding Fix)
    const buf = Buffer.from(subRes.data);
    let str = buf.toString('utf8');
    if (str.includes('')) str = iconv.decode(buf, 'win1256'); // اكتشاف ترميز الويندوز القديم
    originalText = str;
  } catch (err) { return res.redirect(subUrl); }

  const isAss = isAssUrl(subUrl) || /^\uFEFF?\[Script Info\]/im.test(originalText);
  let outputText = originalText;

  try {
    const assParsed = isAss ? parseAss(originalText) : null;
    const srtParsed = assParsed ? null : parseSrt(originalText);
    const cues = assParsed ? assParsed.dialogues : (srtParsed || []);

    if (cues.length > 0) {
      // Masking
      const maskedCues = cues.map(c => {
        const { masked, tags } = maskTags(c.text);
        return { originalText: c.text, masked, tags };
      });
      const textsToTranslate = maskedCues.map(c => c.masked);
      
      const translated = await translateTextArray(textsToTranslate, keys);
      
      if (translated && translated.length === cues.length) {
        // Unmasking & Rebuilding
        if (assParsed) {
          const outLines = [...assParsed.headerLines];
          assParsed.dialogues.forEach((d, i) => {
            outLines.push(`${d.prefix}: ${d.before.join(',')},${unmaskTags(translated[i], maskedCues[i].tags)}`);
          });
          outputText = outLines.join('\n') + '\n';
        } else {
          outputText = buildAssFromCues(srtParsed.map((c, i) => ({ 
            start: c.start, end: c.end, text: unmaskTags(translated[i], maskedCues[i].tags) 
          })));
        }
      } else {
        // 8. منع الفشل الصامت
        const errorMsg = "[النظام] عذراً، فشلت الترجمة الفورية بسبب ضغط الخوادم أو رفض الاستجابة.";
        if (assParsed) {
          outputText = assParsed.headerLines.join('\n') + `\nDialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${errorMsg}\n`;
        } else {
          outputText = ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${errorMsg}\n`;
        }
      }
    }
  } catch (e) { logErr('translate:process', e); }

  res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
  res.send(outputText);
});

// ============= جلب الترجمات الشاملة =============
app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json', '/:config/subtitles/:type/:id.json', '/:config/subtitles/:type/:id/:extra.json'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { type, id, extra } = req.params;
  let targetId = extra && extra.endsWith('.json') ? `${id}/${extra.replace('.json', '')}` : id.replace('.json', '');
  const config = decodeConfig(req.params.config);

  const animeInfo = await resolveExternalId(targetId);
  const targetIds = [targetId];
  if (animeInfo?.imdbId && !targetIds.includes(animeInfo.imdbId)) targetIds.push(animeInfo.imdbId);
  if (animeInfo?.kitsuId && animeInfo?.absoluteEp && !targetIds.includes(`kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`)) {
    targetIds.push(`kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`);
  }

  const requests = [];
  for (const tid of targetIds) {
    const fetchType = (tid.startsWith('kitsu') || type === 'anime') ? 'series' : type;
    requests.push(...buildMirrorRequests(tid, fetchType, false));
  }

  // 5. البحث الاحتياطي بالاسم (Fallback Search)
  if (animeInfo?.title) {
    const q = `${animeInfo.title} ${animeInfo.absoluteEp || ''}`.trim();
    requests.push(
      axios.get(`https://animetosho.org/api/v1/search?q=${encodeURIComponent(q)}`, getAxiosConfig())
        .then(r => (r.data?.results || []).filter(i => i.attachment_url).map(i => ({
          url: i.attachment_url, lang: 'eng', origName: i.title, _source: 'animetosho'
        }))).catch(() => [])
    );
  }

  const results = await Promise.all(requests);
  let rawSubtitles = results.flat();

  // 7. الفلترة الذكية بدون فحص بطيء
  const uniqueMap = new Map();
  for (const sub of rawSubtitles) {
    if (!sub || !sub.url) continue;
    const extMatch = sub.url.match(/\.(srt|ass|ssa|vtt)(\?|$)/i);
    sub._ext = extMatch ? extMatch[1].toLowerCase() : 'srt';
    // منع التكرار بناءً على رابط التحميل أو الاسم الدقيق
    const key = sub.url.split('?')[0] + (sub.origName || '');
    if (!uniqueMap.has(key)) uniqueMap.set(key, sub);
  }
  rawSubtitles = Array.from(uniqueMap.values());

  const arabicSubs = [];
  const nonArabicSubs = [];
  const host = req.get('host');
  const protocol = req.protocol;

  for (const sub of rawSubtitles) {
    const l = (sub.lang || '').toLowerCase();
    const isArabic = l === 'ara' || l === 'ar' || l.includes('ara');
    
    // 11. و 12. التسمية الإجبارية (الاسم الأصلي • المصدر • الامتداد)
    const orig = sub.origName || (isArabic ? 'ترجمة عربية' : 'Subtitle');
    const packTag = sub._seasonPack ? ' [باقة الموسم]' : '';
    const name = `${orig} • ${sourceLabelOf(sub._source)} • ${sub._ext.toUpperCase()}${packTag}`;
    
    const formattedSub = { id: `sub_${sub.url}`, url: sub.url, lang: isArabic ? 'ara' : (l || 'eng'), name: name, title: name, _ext: sub._ext, _source: sub._source, _lang: l, origName: orig };
    isArabic ? arabicSubs.push(formattedSub) : nonArabicSubs.push(formattedSub);
  }

  // الترتيب: ASS ثم VTT ثم SRT
  const formatRank = { ass: 0, ssa: 0, vtt: 1, srt: 2 };
  const sorter = (a, b) => (formatRank[a._ext] ?? 3) - (formatRank[b._ext] ?? 3);
  arabicSubs.sort(sorter);
  nonArabicSubs.sort(sorter);

  // 13. القطع بناءً على الحد الأقصى للمستخدم
  const limitedArabic = arabicSubs.slice(0, config.limit);

  // 1. و 12. تجهيز 5 تراجم للذكاء الاصطناعي
  const AI_MAX = 5;
  const aiSubs = [];
  const hasAiKey = config.geminiKey || config.groqKey || config.openaiKey;
  if (nonArabicSubs.length > 0 && hasAiKey) {
    const candidates = nonArabicSubs.slice(0, AI_MAX);
    const configToken = req.params.config || '';
    const base = configToken ? `${protocol}://${host}/${configToken}` : `${protocol}://${host}`;

    candidates.forEach((cand, idx) => {
      const aiProxyUrl = `${base}/translate/trans.ass?subUrl=${encodeURIComponent(cand.url)}`;
      // قاعدة trans الصارمة
      const aiName = `${cand.origName} • ${sourceLabelOf(cand._source)} • trans • ASS`;
      aiSubs.push({ id: `trans_${idx + 1}`, url: aiProxyUrl, lang: 'ara', name: aiName, title: aiName });
    });
  }

  // النتيجة النهائية
  const finalArabic = limitedArabic.map(({ _ext, _source, _lang, origName, ...rest }) => rest);
  res.json({ subtitles: [...finalArabic, ...aiSubs] });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
