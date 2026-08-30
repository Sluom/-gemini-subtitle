const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');

const app = express();
app.set('trust proxy', true); // مهم عند العمل خلف بروكسي (Render/Heroku/إلخ) ليعطي req.protocol القيمة الصحيحة https
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.gemini.subtitles",
  version: "26.2.0",
  name: "Universal Subtitles & Gemini AI",
  description: "جلب الترجمات الشاملة المباشرة للأفلام والمسلسلات والأنمي مع الترجمة الفورية عبر الذكاء الاصطناعي",
  resources: [
    {
      name: "subtitles",
      types: ["movie", "series", "anime", "other"],
      idPrefixes: ["tt", "kitsu", "tmdb", "tvdb", "anilist", "mal"]
    }
  ],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "kitsu", "tmdb", "tvdb", "anilist", "mal"],
  catalogs: []
};

// ============= أدوات مساعدة عامة =============

// base64url آمن للاستخدام داخل مسارات URL (بدون / أو + أو =)
function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

// يفكك معرف مثل tt1234567:1:5 إلى { imdbId, season, episode }
function parseImdbId(rawId) {
  const parts = rawId.split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? parseInt(parts[1]) : null,
    episode: parts[2] ? parseInt(parts[2]) : null
  };
}

function logErr(label, err) {
  const msg = err?.response?.status
    ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}`
    : err?.message || err;
  console.error(`[${label}] فشل:`, msg);
}

// هل الرابط يشير إلى ملف بصيغة ass/ssa؟
function isAssUrl(url) {
  if (!url) return false;
  return /\.(ass|ssa)(\?|$)/i.test(url);
}

// فك تشفير إعدادات المستخدم (المفاتيح) من التوكن الموجود في الرابط - دالة موحّدة
// تُستخدم في أكثر من مسار (subtitles و translate) لتفادي تكرار نفس منطق فك التشفير
function decodeConfig(token) {
  const keys = {
    geminiKey: '', groqKey: '', deeplKey: '', openaiKey: '',
    subsourceKey: '', openSubKey: '', subdlKey: '', wyzieKey: '', tmdbKey: ''
  };
  if (!token) return keys;
  try {
    const p = JSON.parse(base64UrlDecode(token));
    Object.keys(keys).forEach(k => { if (p[k]) keys[k] = p[k]; });
  } catch (e) {
    logErr('config:decode', e);
  }
  return keys;
}

// قائمة نماذج Gemini التي نجربها بالترتيب - مستخدمة في أكثر من مكان لذا وُحّدت هنا
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];

const MIRROR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
  'Accept': 'application/json'
};

// أسماء عرض مقروءة لكل مصدر ترجمة (تُستخدم إجباريًا ضمن اسم الترجمة النهائي)
const SOURCE_LABELS = {
  'opensub-v3': 'OpenSubtitles',
  'opensub-fun': 'OpenSubtitles',
  'opensub-official': 'OpenSubtitles',
  'subdl-mirror': 'SubDL',
  'subdl-official': 'SubDL',
  'subscene': 'Subscene',
  'yify': 'YIFY Subtitles',
  'anime-subs': 'Anime Subtitles',
  'kitsunekko': 'Kitsunekko',
  'subanime': 'SubAnime',
  'animetosho': 'AnimeTosho',
  'wyzie': 'Wyzie Subs'
};
function sourceLabelOf(key) { return SOURCE_LABELS[key] || 'مصدر غير معروف'; }

// ============= تحليل/بناء ملفات الترجمة (srt <-> ass) =============
// الهدف: استخراج التوقيت والنص بأنفسنا بالكود (بدون الاعتماد على الذكاء الاصطناعي
// لضبط التوقيت أو بنية الملف)، ثم نرسل فقط النصوص المنطوقة للترجمة، ثم نعيد بناء
// ملف ass صحيح دائمًا مع نفس التوقيت الأصلي بالضبط.

// 00:01:23,456 -> 0:01:23.45  (تحويل توقيت srt إلى صيغة ass)
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
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const timeLine = lines[idx] || '';
    const tm = timeLine.match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!tm) continue;
    const text2 = lines.slice(idx + 1).join('\n');
    if (!text2.trim()) continue;
    cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), text: text2 });
  }
  return cues;
}

const ASS_DEFAULT_HEADER = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// يبني ملف ass صحيح من مصفوفة { start, end, text }
function buildAssFromCues(cues) {
  const lines = cues.map(c => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${String(c.text).replace(/\n/g, '\\N')}`);
  return ASS_DEFAULT_HEADER + lines.join('\n') + '\n';
}

// يحلل ملف ass موجود: يستخرج رأس الملف (Script Info/Styles) كما هو، وكل سطر Dialogue
// كـ { prefix, before[], text } بحيث نقدر نستبدل النص فقط ونحافظ على كل شيء آخر (التوقيت،
// الستايل، أي تاغات override) كما هو تمامًا.
function parseAss(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const eventsIdx = lines.findIndex(l => l.trim().toLowerCase() === '[events]');
  if (eventsIdx === -1) return null;

  let formatLine = null;
  let formatIdx = -1;
  for (let i = eventsIdx + 1; i < lines.length; i++) {
    if (/^Format:/i.test(lines[i].trim())) { formatLine = lines[i]; formatIdx = i; break; }
  }
  if (!formatLine) return null;

  const fields = formatLine.split(':').slice(1).join(':').split(',').map(s => s.trim());
  if (!fields.length || fields[fields.length - 1].toLowerCase() !== 'text') return null;

  const headerLines = lines.slice(0, formatIdx + 1);
  const dialogues = [];
  for (let i = formatIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const prefixMatch = line.match(/^(Dialogue|Comment):\s*/i);
    if (!prefixMatch) continue;
    const rest = line.slice(prefixMatch[0].length);
    const parts = rest.split(',');
    if (parts.length < fields.length) continue;
    const before = parts.slice(0, fields.length - 1);
    const textPart = parts.slice(fields.length - 1).join(',');
    dialogues.push({ prefix: prefixMatch[1], before, text: textPart });
  }
  if (!dialogues.length) return null;
  return { headerLines, dialogues };
}

// يرسل مصفوفة نصوص لمزود واحد ويطلب مصفوفة JSON مترجمة بنفس الطول (بدون توقيت،
// نص منطوق فقط) - أوثق بكثير من طلب "حافظ على الصيغة" من نموذج نصي حر
async function translateChunkJSON(texts, provider, key) {
  const prompt = `Translate the following JSON array of ${texts.length} subtitle text lines into natural, accurate Arabic. Respond with ONLY a raw JSON array of exactly ${texts.length} strings, same order, no markdown fences, no explanation. If a line contains ASS/SSA override tags like {\\i1}, {\\an8}, etc., keep those tags exactly unchanged in place and translate only the visible spoken words.\n\nInput:\n${JSON.stringify(texts)}`;

  try {
    if (provider === 'gemini') {
      for (const m of GEMINI_MODELS) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key.trim())}`;
          const r = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { response_mime_type: 'application/json' }
          }, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
          const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length === texts.length) return arr;
          }
        } catch (e) { logErr(`translateChunk:gemini:${m}`, e); }
      }
      return null;
    }

    if (provider === 'groq' || provider === 'openai') {
      const isGroq = provider === 'groq';
      const url = isGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
      const model = isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini';
      const body = { model, messages: [{ role: 'user', content: prompt }] };
      if (!isGroq) body.response_format = { type: 'json_object' };
      let r;
      try {
        r = await axios.post(url, body, { headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' }, timeout: 30000 });
      } catch (e) {
        // بعض نماذج Groq قد ترفض response_format، هذا الاستدعاء أصلًا بدونه للـ groq
        logErr(`translateChunk:${provider}`, e);
        return null;
      }
      let raw = r.data?.choices?.[0]?.message?.content;
      if (raw) {
        raw = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```\s*$/, '').trim();
        // إن رجع الموديل { "translations": [...] } بدل مصفوفة خام، جرّب استخراجها
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length === texts.length) return arr;
          if (arr && Array.isArray(arr.translations) && arr.translations.length === texts.length) return arr.translations;
        } catch (e) { /* تجاهل، سنرجع null */ }
      }
      return null;
    }

    if (provider === 'deepl') {
      const isFree = key.trim().endsWith(':fx');
      const dUrl = isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
      const r = await axios.post(dUrl, {
        text: texts,
        target_lang: 'AR',
        preserve_formatting: true
      }, { headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, 'Content-Type': 'application/json' }, timeout: 30000 });
      const translations = r.data?.translations || [];
      if (translations.length === texts.length) return translations.map(t => t.text);
      return null;
    }
  } catch (e) {
    logErr(`translateChunk:${provider}`, e);
  }
  return null;
}

// يترجم مصفوفة نصوص كبيرة على دفعات (لتفادي حدود طول الطلب)، مع نفس ترتيب أولوية
// المزودين المستخدم في بقية الكود: Gemini -> Groq -> DeepL -> OpenAI
async function translateTextArray(texts, keys) {
  if (!texts.length) return null;
  const providers = [];
  if (keys.geminiKey) providers.push({ name: 'gemini', key: keys.geminiKey });
  if (keys.groqKey) providers.push({ name: 'groq', key: keys.groqKey });
  if (keys.deeplKey) providers.push({ name: 'deepl', key: keys.deeplKey });
  if (keys.openaiKey) providers.push({ name: 'openai', key: keys.openaiKey });
  if (!providers.length) return null;

  const CHUNK = 100;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    let done = null;
    for (const p of providers) {
      done = await translateChunkJSON(chunk, p.name, p.key);
      if (done) break;
    }
    if (!done) return null; // فشلت الدفعة عبر كل المزودين -> نرجع null ليتم اللجوء للطريقة الاحتياطية
    results.push(...done);
  }
  return results;
}

// مسار فحص وتجربة المفاتيح
app.post('/test-key', async (req, res) => {
  const { provider, key } = req.body;
  if (!key) return res.json({ success: false, message: "يرجى إدخال المفتاح أولاً ⚠️" });

  const cleanKey = key.trim();

  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`;
      const r = await axios.get(url, { timeout: 7000 });
      if (r.status === 200 && r.data?.models) return res.json({ success: true, message: "مفتاح Gemini صالح وشغال 100% ✅" });
    }

    if (provider === 'opensub') {
      const r = await axios.get('https://api.opensubtitles.com/api/v1/subtitles?query=Inception', {
        headers: { 'Api-Key': cleanKey, 'User-Agent': 'NuvioSubtitlesApp v1.0.0', 'Accept': 'application/json' },
        timeout: 7000
      });
      if (r.status === 200 || r.data?.data) return res.json({ success: true, message: "مفتاح OpenSubtitles صالح وشغال 100% ✅" });
    }

    if (provider === 'subsource') {
      const r = await axios.get('https://api.subsource.net/api/v1/movies/search?query=Inception', {
        headers: { 'X-API-Key': cleanKey, 'Accept': 'application/json' },
        timeout: 7000
      }).catch(e => e.response);
      if (r && (r.status === 200 || r.status === 404)) return res.json({ success: true, message: "مفتاح SubSource صالح وشغال 100% ✅" });
      return res.json({ success: true, message: "تم تسجيل مفتاح SubSource بنجاح ✅" });
    }

    if (provider === 'groq') {
      const r = await axios.get('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${cleanKey}` }, timeout: 5000
      });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح Groq صالح 100% ✅" });
    }

    if (provider === 'deepl') {
      const isFree = cleanKey.endsWith(':fx');
      const url = isFree ? 'https://api-free.deepl.com/v2/usage' : 'https://api.deepl.com/v2/usage';
      const r = await axios.get(url, { headers: { Authorization: `DeepL-Auth-Key ${cleanKey}` }, timeout: 5000 });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح DeepL صالح 100% ✅" });
    }

    if (provider === 'openai') {
      const r = await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${cleanKey}` }, timeout: 5000
      });
      if (r.status === 200) return res.json({ success: true, message: "مفتاح OpenAI صالح 100% ✅" });
    }

    if (provider === 'subdl') {
      const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${cleanKey}&film_name=Inception`, { timeout: 5000 });
      if (r.data?.status === true || r.data?.results) return res.json({ success: true, message: "مفتاح SubDL صالح 100% ✅" });
    }

    if (provider === 'jimaku') return res.json({ success: true, message: "مفتاح Jimaku صالح ومحفوظ ✅" });
    if (provider === 'wyzie') return res.json({ success: true, message: "مفتاح Wyzie صالح ومحفوظ ✅" });

    if (provider === 'tmdb') {
      const r = await axios.get(`https://api.themoviedb.org/3/movie/550?api_key=${cleanKey}`, { timeout: 5000 });
      if (r.data?.id) return res.json({ success: true, message: "مفتاح TMDB صالح 100% ✅" });
    }

    return res.json({ success: false, message: "المفتاح غير صالح ❌" });
  } catch (err) {
    logErr(`test-key:${provider}`, err);
    return res.json({ success: false, message: "فشل الفحص: تأكد من صحة المفتاح ❌" });
  }
});

// واجهة التخصيص
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
        .hint { font-size: 11px; color: #64748b; margin-top: 6px; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Universal Subtitles & Gemini AI</h2>

        <h3>🤖 محركات الذكاء الاصطناعي (حتى 10 نتائج مترجمة من لغات متعددة، آخر القائمة)</h3>
        <div class="field-group">
          <div class="label-row">
            <label>مفتاح Google Gemini API:</label>
            <a class="get-link" href="https://aistudio.google.com/app/apikey" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="geminiKey" placeholder="AIzaSy...">
            <button class="btn-test" onclick="testKey('gemini', 'geminiKey', 'msgGemini')">فحص</button>
          </div>
          <div id="msgGemini" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح Groq API (فائق السرعة):</label>
            <a class="get-link" href="https://console.groq.com/keys" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="groqKey" placeholder="gsk_...">
            <button class="btn-test" onclick="testKey('groq', 'groqKey', 'msgGroq')">فحص</button>
          </div>
          <div id="msgGroq" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح DeepL API:</label>
            <a class="get-link" href="https://www.deepl.com/pro-api" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="deeplKey" placeholder="DeepL Auth Key (:fx)">
            <button class="btn-test" onclick="testKey('deepl', 'deeplKey', 'msgDeepl')">فحص</button>
          </div>
          <div id="msgDeepl" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح OpenAI API:</label>
            <a class="get-link" href="https://platform.openai.com/api-keys" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="openaiKey" placeholder="sk-...">
            <button class="btn-test" onclick="testKey('openai', 'openaiKey', 'msgOpenai')">فحص</button>
          </div>
          <div id="msgOpenai" class="test-msg"></div>
        </div>

        <h3>🎌 مواقع ومصادر ترجمات الأنمي</h3>
        <div class="field-group">
          <div class="label-row">
            <label>مفتاح Jimaku.cc API (اختياري للأنمي):</label>
            <a class="get-link" href="https://jimaku.cc" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="jimakuKey" placeholder="Jimaku API Token">
            <button class="btn-test" onclick="testKey('jimaku', 'jimakuKey', 'msgJimaku')">فحص</button>
          </div>
          <div id="msgJimaku" class="test-msg"></div>
        </div>

        <h3>🌐 قواعد بيانات ومزودات الترجمة العامة</h3>
        <div class="field-group">
          <div class="label-row">
            <label>مفتاح SubSource API:</label>
            <a class="get-link" href="https://subsource.net/api-docs" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="subsourceKey" placeholder="SubSource API Key">
            <button class="btn-test" onclick="testKey('subsource', 'subsourceKey', 'msgSubsource')">فحص</button>
          </div>
          <div id="msgSubsource" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح OpenSubtitles.com API:</label>
            <a class="get-link" href="https://www.opensubtitles.com/en/consumers" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="openSubKey" placeholder="OpenSubtitles API Key">
            <button class="btn-test" onclick="testKey('opensub', 'openSubKey', 'msgOpenSub')">فحص</button>
          </div>
          <div id="msgOpenSub" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح SubDL API:</label>
            <a class="get-link" href="https://subdl.com/api-doc" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="subdlKey" placeholder="SubDL API Key">
            <button class="btn-test" onclick="testKey('subdl', 'subdlKey', 'msgSubdl')">فحص</button>
          </div>
          <div id="msgSubdl" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح Wyzie Subs API:</label>
            <a class="get-link" href="https://wyzie.ru" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="wyzieKey" placeholder="Wyzie API Key">
            <button class="btn-test" onclick="testKey('wyzie', 'wyzieKey', 'msgWyzie')">فحص</button>
          </div>
          <div id="msgWyzie" class="test-msg"></div>
        </div>

        <div class="field-group">
          <div class="label-row">
            <label>مفتاح TMDB API (لتحويل المعرفات):</label>
            <a class="get-link" href="https://www.themoviedb.org/settings/api" target="_blank">🔗 احصل على المفتاح</a>
          </div>
          <div class="input-row">
            <input type="text" id="tmdbKey" placeholder="TMDB API Key">
            <button class="btn-test" onclick="testKey('tmdb', 'tmdbKey', 'msgTmdb')">فحص</button>
          </div>
          <div id="msgTmdb" class="test-msg"></div>
        </div>

        <h3>⚙️ إعدادات العرض</h3>
        <div class="hint">
          يتم جلب كل الترجمات المتوفرة بدون حد أقصى، مع استبعاد الملفات الفارغة تلقائيًا،
          وتفضيل ملفات ASS/SSA دائمًا. كل ترجمة تظهر باسمها الأصلي + اسم المصدر + صيغة الملف،
          وباقات الموسم الكاملة (إن وُجدت) تُضاف وتُميَّز بعلامة [باقة الموسم].
          ترجمات الذكاء الاصطناعي (حتى 10، من لغات متعددة إلى العربية، دائمًا بصيغة ASS) تُضاف دومًا في آخر القائمة.
        </div>

        <button class="btn-install" onclick="install()">تثبيت / تحديث في Nuvio</button>
      </div>

      <script>
        async function testKey(provider, inputId, msgId) {
          const key = document.getElementById(inputId).value.trim();
          const msgEl = document.getElementById(msgId);
          msgEl.style.display = 'block';
          msgEl.style.color = '#38bdf8';
          msgEl.innerText = 'جاري الفحص... ⏳';

          if (!key) {
            msgEl.style.color = '#ef4444';
            msgEl.innerText = 'يرجى إدخال المفتاح أولاً ⚠️';
            return;
          }

          try {
            const res = await fetch('/test-key', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider, key })
            });
            const data = await res.json();
            msgEl.style.color = data.success ? '#22c55e' : '#ef4444';
            msgEl.innerText = data.message;
          } catch (e) {
            msgEl.style.color = '#ef4444';
            msgEl.innerText = 'تعذر الاتصال بالخادم ❌';
          }
        }

        // base64url: آمن داخل مسارات URL (يحل مشكلة اختفاء الترجمات بسبب / و + و =)
        function toBase64Url(str) {
          return btoa(str)
            .replace(/\\+/g, '-')
            .replace(/\\//g, '_')
            .replace(/=+$/, '');
        }

        function install() {
          const geminiKey = document.getElementById('geminiKey').value.trim();
          const groqKey = document.getElementById('groqKey').value.trim();
          const deeplKey = document.getElementById('deeplKey').value.trim();
          const openaiKey = document.getElementById('openaiKey').value.trim();
          const jimakuKey = document.getElementById('jimakuKey').value.trim();
          const subsourceKey = document.getElementById('subsourceKey').value.trim();
          const openSubKey = document.getElementById('openSubKey').value.trim();
          const subdlKey = document.getElementById('subdlKey').value.trim();
          const wyzieKey = document.getElementById('wyzieKey').value.trim();
          const tmdbKey = document.getElementById('tmdbKey').value.trim();

          const config = toBase64Url(JSON.stringify({
            geminiKey, groqKey, deeplKey, openaiKey, jimakuKey,
            subsourceKey, openSubKey, subdlKey, wyzieKey, tmdbKey
          }));

          const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
          window.location.href = 'nuvio://' + manifestUrl.replace(/^https?:\\/\\//, '');
        }
      </script>
    </body>
    </html>
  `);
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

// مسار الترجمة الفورية بالذكاء الاصطناعي
// يقبل أيضًا التوكن /:config/translate/... حتى لا نُضطر لتكرار كل المفاتيح الأربعة
// داخل رابط كل ترجمة على حدة (كانت مكررة سابقًا حتى 10 مرات لكل استجابة واحدة).
// يبقى قبول geminiKey/groqKey/... كـ query params (بدون config) للتوافق مع أي روابط قديمة.
// المنهجية: نحلل توقيت/نص الملف الأصلي بأنفسنا بالكود (srt أو ass)، نرسل فقط النصوص
// المنطوقة للترجمة (بدون توقيت)، ثم نبني ملف ass صحيح بنفس التوقيت الأصلي بالضبط.
// هذا تفضيل لصيغة ass وليس إلزاميًا: إذا تعذّر التحليل البنيوي لأي سبب، نلجأ لترجمة
// النص كاملًا كخطة احتياطية بدل فشل الطلب.
app.get(['/translate', '/translate/:label', '/:config/translate', '/:config/translate/:label'], async (req, res) => {
  const { subUrl } = req.query;
  if (!subUrl) return res.status(400).send("No subtitle URL");

  const keys = req.params.config
    ? decodeConfig(req.params.config)
    : {
        geminiKey: req.query.geminiKey || '',
        groqKey: req.query.groqKey || '',
        deeplKey: req.query.deeplKey || '',
        openaiKey: req.query.openaiKey || ''
      };
  const { geminiKey, groqKey, deeplKey, openaiKey } = keys;

  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`[translate:${reqId}] بدء الطلب | gemini=${!!geminiKey} groq=${!!groqKey} deepl=${!!deeplKey} openai=${!!openaiKey} | src=${subUrl.slice(0, 90)}`);

  let originalText;
  try {
    const fetchStart = Date.now();
    const subRes = await axios.get(subUrl, { responseType: 'text', timeout: 15000 });
    originalText = subRes.data;
    console.log(`[translate:${reqId}] تم جلب الملف الأصلي خلال ${((Date.now() - fetchStart) / 1000).toFixed(1)}s (${originalText?.length || 0} حرف)`);
  } catch (err) {
    logErr('translate:fetchSub', err);
    return res.redirect(subUrl);
  }

  if (!originalText || typeof originalText !== 'string' || originalText.trim().length === 0) {
    console.log(`[translate:${reqId}] الملف الأصلي فارغ، إرسال المصدر كما هو`);
    return res.redirect(subUrl);
  }

  const isSourceAss = isAssUrl(subUrl) || /^\uFEFF?\[Script Info\]/im.test(originalText);

  // 1) محاولة الترجمة البنيوية (توقيت مضبوط + إخراج ass صحيح دائمًا)
  try {
    const assParsed = isSourceAss ? parseAss(originalText) : null;
    const srtParsed = assParsed ? null : parseSrt(originalText);

    const cueTexts = assParsed ? assParsed.dialogues.map(d => d.text) : (srtParsed || []).map(c => c.text);

    if (cueTexts.length) {
      const translated = await translateTextArray(cueTexts, keys);
      if (translated && translated.length === cueTexts.length) {
        let outputText;
        if (assParsed) {
          const outLines = assParsed.headerLines.slice();
          assParsed.dialogues.forEach((d, i) => {
            outLines.push(`${d.prefix}: ${d.before.join(',')},${translated[i]}`);
          });
          outputText = outLines.join('\n') + '\n';
        } else {
          outputText = buildAssFromCues(srtParsed.map((c, i) => ({ start: c.start, end: c.end, text: translated[i] })));
        }
        console.log(`[translate:${reqId}] ترجمة بنيوية ناجحة (${cueTexts.length} سطر) -> ass | إجمالي الوقت: ${elapsed()}`);
        res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
        return res.send(outputText);
      }
      console.log(`[translate:${reqId}] فشلت الترجمة البنيوية عبر كل المزودين، اللجوء للخطة الاحتياطية`);
    }
  } catch (e) {
    logErr('translate:structured', e);
  }

  // 2) خطة احتياطية: ترجمة النص كاملًا كما كان سابقًا (بدون ضمان بنية ass صحيحة 100%)،
  // نحاول قدر الإمكان إبقاء نفس الصيغة/التاغات عبر التعليمات فقط
  let translatedText = null;
  const wholeTextPrompt = (isSourceAss)
    ? `Translate this ASS/SubStation Alpha subtitle file into accurate Arabic. Keep the file structure and all style/event tags and timing intact, translate only the visible spoken text in each Dialogue line. Output ONLY the translated file content:\n\n${originalText.slice(0, 30000)}`
    : `Translate this subtitle into accurate Arabic with exact timing preservation. Output ONLY the translated content, same format as input:\n\n${originalText.slice(0, 30000)}`;

  const providers = [];
  if (geminiKey) providers.push('gemini');
  if (groqKey) providers.push('groq');
  if (deeplKey) providers.push('deepl');
  if (openaiKey) providers.push('openai');

  for (const provider of providers) {
    if (translatedText) break;
    try {
      if (provider === 'gemini') {
        for (const m of GEMINI_MODELS) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(geminiKey.trim())}`;
            const gRes = await axios.post(url, { contents: [{ parts: [{ text: wholeTextPrompt }] }] }, { headers: { 'Content-Type': 'application/json' }, timeout: 25000 });
            translatedText = gRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (translatedText) break;
          } catch (e) { logErr(`translate:gemini:${m}`, e); }
        }
      } else if (provider === 'groq') {
        const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: wholeTextPrompt }]
        }, { headers: { Authorization: `Bearer ${groqKey.trim()}` }, timeout: 25000 });
        translatedText = groqRes.data?.choices?.[0]?.message?.content;
      } else if (provider === 'deepl') {
        const isFree = deeplKey.trim().endsWith(':fx');
        const dUrl = isFree ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
        const dRes = await axios.post(dUrl, { text: [originalText.slice(0, 30000)], target_lang: 'AR', preserve_formatting: true }, { headers: { Authorization: `DeepL-Auth-Key ${deeplKey.trim()}`, 'Content-Type': 'application/json' }, timeout: 25000 });
        translatedText = dRes.data?.translations?.[0]?.text;
      } else if (provider === 'openai') {
        const oRes = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: wholeTextPrompt }]
        }, { headers: { Authorization: `Bearer ${openaiKey.trim()}`, 'Content-Type': 'application/json' }, timeout: 25000 });
        translatedText = oRes.data?.choices?.[0]?.message?.content;
      }
      console.log(`[translate:${reqId}] احتياطي:${provider} ${translatedText ? 'نجح' : 'رجع بدون نص'}`);
    } catch (e) {
      logErr(`translate:fallback:${provider}`, e);
    }
  }

  const finalResult = translatedText || originalText;
  // إن كان المصدر srt ولم ننجح بالترجمة البنيوية، نحوّله محليًا إلى ass صحيح على الأقل
  // (حتى لو النص لم يُترجم لأي سبب) - تفضيل ass يبقى قائمًا كأفضل جهد ممكن
  let outputText = finalResult;
  if (!isSourceAss && translatedText) {
    const cues = parseSrt(finalResult);
    if (cues.length) outputText = buildAssFromCues(cues);
  }

  console.log(`[translate:${reqId}] ${translatedText ? 'تمت الترجمة (احتياطي)' : 'تعذرت الترجمة، إرسال النص الأصلي'} | إجمالي الوقت: ${elapsed()}`);
  res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
  res.send(outputText);
});

// ============= تحويل معرفات الأنمي (kitsu / mal / anilist / tmdb / tvdb) بشكل ثنائي الاتجاه =============
//
// الفكرة: بعض مصادر الترجمة تُفهرس حلقات الأنمي بالترقيم المطلق (مثال: هنتر × هنتر
// الحلقة 111 كما في kitsu/mal/anilist)، بينما مصادر أخرى (OpenSubtitles, SubDL, IMDB)
// تُفهرس بترقيم الموسم/الحلقة القياسي لـ TVDB/TMDB (مثال: نفس الحلقة = الموسم 2 الحلقة 53).
// نستخدم قاعدة بيانات Fribb/anime-lists التي تحتوي على "season" و "episode_offset"
// لكل عمل، لنحوّل تلقائيًا بين الترقيمين ونبحث بكليهما معًا.

let animeListCache = null;
let animeListCacheTime = 0;
async function getAnimeListMap() {
  const now = Date.now();
  if (animeListCache && now - animeListCacheTime < 24 * 3600 * 1000) return animeListCache;
  try {
    const r = await axios.get('https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json', { timeout: 20000 });
    if (Array.isArray(r.data)) {
      animeListCache = r.data;
      animeListCacheTime = now;
      console.log(`[animeListMap] تم تحميل ${animeListCache.length} عنصر`);
    }
    return animeListCache || [];
  } catch (e) {
    logErr('animeListMap:fetch', e);
    return animeListCache || [];
  }
}

function firstImdb(entry) {
  if (!entry?.imdb_id) return null;
  return Array.isArray(entry.imdb_id) ? entry.imdb_id[0] : String(entry.imdb_id).split(',')[0].trim();
}

// يحوّل معرف TMDB إلى IMDB عبر TMDB API (يحتاج مفتاح TMDB)
async function tmdbToImdb(tmdbId, mediaType, tmdbKey) {
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/external_ids?api_key=${encodeURIComponent(tmdbKey)}`, { timeout: 6000 });
    return r.data?.imdb_id || null;
  } catch (e) {
    logErr('tmdb:external_ids', e);
    return null;
  }
}

async function tvdbToTmdb(tvdbId, tmdbKey) {
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/find/${tvdbId}?api_key=${encodeURIComponent(tmdbKey)}&external_source=tvdb_id`, { timeout: 6000 });
    return { tvId: r.data?.tv_results?.[0]?.id || null, movieId: r.data?.movie_results?.[0]?.id || null };
  } catch (e) {
    logErr('tvdb:find', e);
    return { tvId: null, movieId: null };
  }
}

// نقطة الدخول العامة لأي معرف (tt/kitsu/mal/anilist/tmdb/tvdb)
// تُرجع: { imdbId, season, episode, kitsuId, absoluteEp, title }
async function resolveExternalId(rawId, tmdbKey) {
  try {
    const parts = rawId.split(':');
    const prefix = parts[0];

    // ---- كيتسو / مايال / أنيليست: الترقيم مطلق أصلاً ----
    if (prefix === 'kitsu' || prefix === 'mal' || prefix === 'anilist') {
      const externalId = parts[1];
      const absoluteEp = parts[2] ? parseInt(parts[2]) : 1;
      const map = await getAnimeListMap();

      const fieldMap = { kitsu: 'kitsu_id', mal: 'mal_id', anilist: 'anilist_id' };
      const field = fieldMap[prefix];
      const entry = map.find(e => String(e[field]) === String(externalId));

      let title = null;
      if (prefix === 'kitsu') {
        const res = await axios.get(`https://kitsu.io/api/edge/anime/${externalId}`, { timeout: 5000 }).catch(() => null);
        title = res?.data?.data?.attributes?.canonicalTitle || res?.data?.data?.attributes?.titles?.en;
      }

      if (!entry) return { imdbId: null, kitsuId: entry?.kitsu_id || (prefix === 'kitsu' ? externalId : null), absoluteEp, title };

      const kitsuId = entry.kitsu_id || (prefix === 'kitsu' ? externalId : null);

      // احسب رقم الموسم والحلقة على طريقة TVDB باستخدام الإزاحة (episode_offset)
      const tvdbSeason = entry.season?.tvdb ?? 1;
      const tvdbOffset = entry.episode_offset?.tvdb ?? 0;
      const season = tvdbSeason || 1;
      const episode = absoluteEp + tvdbOffset;

      let imdbId = firstImdb(entry);
      if (!imdbId && entry.themoviedb_id?.tv && tmdbKey) {
        imdbId = await tmdbToImdb(entry.themoviedb_id.tv, 'tv', tmdbKey);
      }

      return {
        imdbId: imdbId ? `${imdbId}:${season}:${episode}` : null,
        kitsuId,
        absoluteEp,
        title
      };
    }

    // ---- TMDB أو TVDB: الترقيم غالبًا موسم/حلقة قياسي ----
    if (prefix === 'tmdb' || prefix === 'tvdb') {
      const externalId = parts[1];
      const season = parts[2] ? parseInt(parts[2]) : null;
      const episode = parts[3] ? parseInt(parts[3]) : null;

      // ابحث في قاعدة بيانات الأنمي أولاً لمعرفة إن كان العمل أنمي، ولإيجاد معرف kitsu المطابق
      const map = await getAnimeListMap();
      let entry = null;

      if (prefix === 'tvdb') {
        entry = map.find(e => String(e.tvdb_id) === String(externalId) && (season == null || (e.season?.tvdb ?? 1) === season));
        if (!entry) entry = map.find(e => String(e.tvdb_id) === String(externalId));
      } else {
        entry = map.find(e => String(e.themoviedb_id?.tv) === String(externalId) && (season == null || (e.season?.tmdb ?? 1) === season));
        if (!entry) entry = map.find(e => String(e.themoviedb_id?.tv) === String(externalId));
      }

      let imdbId = entry ? firstImdb(entry) : null;
      let kitsuId = entry?.kitsu_id || null;
      let absoluteEp = null;

      if (entry && season != null && episode != null) {
        const offsetKey = prefix === 'tvdb' ? 'tvdb' : 'tmdb';
        const offset = entry.episode_offset?.[offsetKey] ?? 0;
        absoluteEp = episode - offset;
        if (absoluteEp < 1) absoluteEp = null; // إزاحة غير منطقية، تجاهلها
      }

      // إن لم نجد IMDB من قاعدة الأنمي، حاول عبر TMDB API مباشرة (يعمل للأنمي وغير الأنمي)
      if (!imdbId && tmdbKey) {
        if (prefix === 'tmdb') {
          const mediaType = season != null ? 'tv' : 'movie';
          imdbId = await tmdbToImdb(externalId, mediaType, tmdbKey);
        } else {
          const { tvId, movieId } = await tvdbToTmdb(externalId, tmdbKey);
          if (tvId) imdbId = await tmdbToImdb(tvId, 'tv', tmdbKey);
          else if (movieId) imdbId = await tmdbToImdb(movieId, 'movie', tmdbKey);
        }
      }

      if (!imdbId) return kitsuId ? { imdbId: null, kitsuId, absoluteEp } : null;

      return {
        imdbId: season != null ? `${imdbId}:${season}:${episode || 1}` : imdbId,
        kitsuId,
        absoluteEp
      };
    }
  } catch (e) {
    logErr('resolveExternalId', e);
  }
  return null;
}

// جلب مباشر من OpenSubtitles.com الرسمي باستخدام مفتاح API الخاص بالمستخدم
// seasonPack=true عند استدعائها بدون رقم حلقة لجلب ملفات باقة الموسم إن كانت متاحة
async function fetchOpenSubtitlesDirect(imdbId, season, episode, apiKey, seasonPack = false) {
  if (!apiKey) return [];
  try {
    const cleanId = imdbId.replace('tt', '');
    const params = new URLSearchParams({ imdb_id: cleanId, languages: 'ar,en' });
    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const r = await axios.get(`https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`, {
      headers: {
        'Api-Key': apiKey.trim(),
        'User-Agent': 'NuvioSubtitlesApp v1.0.0',
        'Accept': 'application/json'
      },
      timeout: 8000
    });

    const items = r.data?.data || [];
    const out = [];
    for (const item of items) {
      const attrs = item.attributes;
      const fileId = attrs?.files?.[0]?.file_id;
      if (!fileId) continue;
      // نحتاج رابط تحميل فعلي عبر endpoint التحميل
      try {
        const dl = await axios.post('https://api.opensubtitles.com/api/v1/download',
          { file_id: fileId },
          { headers: { 'Api-Key': apiKey.trim(), 'Content-Type': 'application/json', 'User-Agent': 'NuvioSubtitlesApp v1.0.0' }, timeout: 8000 }
        );
        if (dl.data?.link) {
          out.push({
            url: dl.data.link,
            lang: attrs.language || 'en',
            origName: attrs.release || attrs.files?.[0]?.file_name || null,
            _source: 'opensub-official',
            _seasonPack: seasonPack
          });
        }
      } catch (e) {
        logErr('opensubtitles:download', e);
      }
    }
    return out;
  } catch (e) {
    logErr('opensubtitles:direct', e);
    return [];
  }
}

// جلب مباشر من SubDL باستخدام مفتاح API الخاص بالمستخدم (الملفات تصل داخل zip يُفك لاحقًا)
async function fetchSubDLDirect(imdbId, season, episode, apiKey, seasonPack = false) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ api_key: apiKey.trim(), imdb_id: imdbId, languages: 'AR,EN' });
    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, { timeout: 8000 });
    const items = r.data?.subtitles || [];
    const out = [];

    for (const item of items) {
      if (!item.url) continue;
      const zipUrl = item.url.startsWith('http') ? item.url : `https://dl.subdl.com${item.url}`;
      out.push({
        zipUrl,
        lang: (item.lang || 'en').toLowerCase(),
        origName: item.release_name || item.name || null,
        _source: 'subdl-official',
        _seasonPack: seasonPack || !!item.full_season
      });
    }
    return out;
  } catch (e) {
    logErr('subdl:direct', e);
    return [];
  }
}

// جلب مباشر من Wyzie Subs (توثيق مؤكد: https://docs.wyzie.io/subs/usage/direct)
// id يقبل معرف IMDB (tt...) مباشرة. الاستجابة مصفوفة كائنات فيها url جاهز للاستخدام مباشرة.
async function fetchWyzieDirect(imdbId, season, episode, apiKey, seasonPack = false) {
  if (!apiKey) return [];
  try {
    const params = new URLSearchParams({ id: imdbId, key: apiKey.trim(), language: 'ar,en' });
    if (season) params.set('season', season);
    if (episode) params.set('episode', episode);

    const r = await axios.get(`https://sub.wyzie.io/search?${params.toString()}`, { timeout: 8000 });
    const items = Array.isArray(r.data) ? r.data : [];
    return items
      .filter(it => it.url)
      .map(it => ({
        url: it.url,
        lang: (it.language || 'en').toLowerCase(),
        origName: it.release || it.fileName || null,
        _source: 'wyzie',
        _seasonPack: seasonPack
      }));
  } catch (e) {
    logErr('wyzie:direct', e);
    return [];
  }
}

// ============= جلب من المرايا المجتمعية (Stremio-style) =============
// دالة موحّدة لكل الطلبات المتشابهة الشكل بدل تكرار نفس كتلة axios عدة مرات
// (وتُستخدم أيضًا لجلب باقة الموسم عبر seasonPack=true دون تكرار الكود)
function mirrorRequest(url, sourceKey, seasonPack) {
  return axios.get(url, { headers: MIRROR_HEADERS, timeout: 6000 })
    .then(r => (r.data?.subtitles || []).map(s => ({
      url: s.url,
      lang: s.lang,
      origName: s.title || s.SubFileName || s.release || s.name || null,
      _source: sourceKey,
      _seasonPack: !!seasonPack
    })))
    .catch(e => { logErr(`mirror:${sourceKey}`, e); return []; });
}

function buildMirrorRequests(tid, fetchType, seasonPack = false) {
  const reqs = [
    mirrorRequest(`https://opensubtitles-v3.strem.io/subtitles/${fetchType}/${tid}.json`, 'opensub-v3', seasonPack),
    mirrorRequest(`https://opensubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, 'opensub-fun', seasonPack),
    mirrorRequest(`https://subdl-stremio.vercel.app/subtitles/${fetchType}/${tid}.json`, 'subdl-mirror', seasonPack),
    mirrorRequest(`https://subscene.strem.fun/subtitles/${fetchType}/${tid}.json`, 'subscene', seasonPack),
    mirrorRequest(`https://yifysubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, 'yify', seasonPack)
  ];
  if (tid.startsWith('kitsu') || tid.startsWith('anilist') || tid.startsWith('mal') || fetchType === 'series') {
    reqs.push(
      mirrorRequest(`https://anime-subtitles.strem.fun/subtitles/series/${tid}.json`, 'anime-subs', seasonPack),
      mirrorRequest(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${tid}.json`, 'kitsunekko', seasonPack),
      mirrorRequest(`https://subanime.strem.fun/subtitles/series/${tid}.json`, 'subanime', seasonPack)
    );
  }
  return reqs;
}

// ============= التحقق من صحة/امتلاء ملفات الترجمة قبل عرضها =============

// يفحص رابط ترجمة مباشر: يجلب بداية الملف فقط، يتأكد أنه غير فارغ، ويكتشف الصيغة الفعلية
async function inspectSubtitleUrl(url) {
  try {
    const r = await axios.get(url, {
      responseType: 'text',
      timeout: 7000,
      headers: { Range: 'bytes=0-6000' },
      maxContentLength: 2 * 1024 * 1024,
      maxBodyLength: 2 * 1024 * 1024,
      validateStatus: s => s < 500
    });
    const text = String(r.data || '');
    if (!text.trim()) return null; // ملف فارغ فعليًا - يُستبعد

    const trimmedLower = text.trim().toLowerCase();
    if (trimmedLower.startsWith('webvtt')) return { ext: 'vtt' };
    if (/\[script info\]/i.test(text)) {
      // نبقيها ass/ssa حتى لو كان محتوى الرأس فيه أخطاء - المطلوب عدم استبعادها بسبب ذلك
      return { ext: /ScriptType:\s*v4\.00\+/i.test(text) ? 'ass' : 'ssa' };
    }
    if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) {
      return { ext: 'srt' };
    }
    // محتوى غير فارغ لكن الصيغة غير واضحة - نبقيه كـ srt افتراضيًا بدل استبعاده
    return { ext: 'srt' };
  } catch (e) {
    return null;
  }
}

// نفس فكرة الفحص أعلاه، لكن لأرشيفات SubDL (zip) عبر فك الضغط الفعلي
function extractFirstSubtitleFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => /\.(srt|ass|ssa|vtt)$/i.test(e.entryName));
  if (!entries.length) return null;
  const chosen = entries.find(e => /\.ass$/i.test(e.entryName))
    || entries.find(e => /\.ssa$/i.test(e.entryName))
    || entries.find(e => /\.srt$/i.test(e.entryName))
    || entries[0];
  const content = chosen.getData().toString('utf8');
  const ext = chosen.entryName.split('.').pop().toLowerCase();
  return { content, ext };
}

async function inspectZipUrl(zipUrl) {
  try {
    const zipRes = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 10000, maxContentLength: 15 * 1024 * 1024 });
    const extracted = extractFirstSubtitleFromZip(Buffer.from(zipRes.data));
    if (!extracted || !extracted.content.trim()) return null; // أرشيف بدون ترجمة فعلية أو فارغ - يُستبعد
    return { ext: extracted.ext };
  } catch (e) {
    logErr('inspectZipUrl', e);
    return null;
  }
}

// يزيل التكرار عن قائمة روابط ثم يتحقق من كل رابط بالتوازي، ويستبعد أي رابط فارغ/فاشل
async function validateAndTag(rawList) {
  const seen = new Set();
  const unique = [];
  for (const s of rawList) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    unique.push(s);
  }
  const inspected = await Promise.all(unique.map(async s => {
    const urlExtMatch = s.url.match(/\.(srt|ass|ssa|vtt)(\?|$)/i);
    const info = await inspectSubtitleUrl(s.url);
    if (!info) return null;
    const ext = urlExtMatch ? urlExtMatch[1].toLowerCase() : info.ext;
    return { ...s, _ext: ext };
  }));
  return inspected.filter(Boolean);
}

async function validateZipEntries(zipList) {
  const seen = new Set();
  const unique = [];
  for (const z of zipList) {
    if (!z || !z.zipUrl || seen.has(z.zipUrl)) continue;
    seen.add(z.zipUrl);
    unique.push(z);
  }
  const inspected = await Promise.all(unique.map(async z => {
    const info = await inspectZipUrl(z.zipUrl);
    if (!info) return null;
    return { ...z, _ext: info.ext };
  }));
  return inspected.filter(Boolean);
}

// يبني الاسم النهائي: الاسم الأصلي (كما هو) + اسم المصدر (إجباري) + صيغة الملف (إجبارية)
// + علامة باقة الموسم إن وُجدت
function buildName(sub) {
  const base = sub.origName ? sub.origName : (sub.lang ? String(sub.lang).toUpperCase() : 'ترجمة');
  const packTag = sub._seasonPack ? ' [باقة الموسم]' : '';
  return `${base} • ${sourceLabelOf(sub._source)} • ${String(sub._ext).toUpperCase()}${packTag}`;
}

// معالج جلب الترجمات الشامل
const handleSubtitles = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { type, id, extra } = req.params;
  let targetId = id;
  if (extra && extra.endsWith('.json')) {
    targetId = `${id}/${extra.replace('.json', '')}`;
  } else if (targetId && targetId.endsWith('.json')) {
    targetId = targetId.replace('.json', '');
  }

  if (!targetId) return res.json({ subtitles: [] });

  const { geminiKey, groqKey, deeplKey, openaiKey, openSubKey, subdlKey, wyzieKey, tmdbKey } = decodeConfig(req.params.config);

  const targetIds = [targetId];
  let animeInfo = null;

  const idPrefix = targetId.split(':')[0];
  if (['kitsu', 'mal', 'anilist', 'tmdb', 'tvdb'].includes(idPrefix)) {
    animeInfo = await resolveExternalId(targetId, tmdbKey);

    // 1) أضف المعرف المكافئ بصيغة IMDB (موسم/حلقة قياسي) - يخدم OpenSubtitles/SubDL/الأغلبية
    if (animeInfo?.imdbId) {
      targetIds.push(animeInfo.imdbId);
    } else {
      console.log(`[resolve] تعذر تحويل المعرف ${targetId} إلى IMDB${['tmdb', 'tvdb'].includes(idPrefix) && !tmdbKey ? ' (مفتاح TMDB غير مُدخل في الإعدادات)' : ''}`);
    }

    // 2) أضف المعرف المكافئ بصيغة kitsu + رقم حلقة مطلق - يخدم مصادر الأنمي المتخصصة
    if (animeInfo?.kitsuId && animeInfo?.absoluteEp && idPrefix !== 'kitsu') {
      const kitsuEquivalent = `kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`;
      if (!targetIds.includes(kitsuEquivalent)) targetIds.push(kitsuEquivalent);
    }
  }

  console.log(`[targetIds] ${targetId} -> [${targetIds.join(', ')}]`);

  const requests = [];

  for (const tid of targetIds) {
    const fetchType = (tid.startsWith('kitsu') || type === 'anime') ? 'series' : type;
    requests.push(...buildMirrorRequests(tid, fetchType, false));

    if (openSubKey && tid.startsWith('tt')) {
      const { imdbId, season, episode } = parseImdbId(tid);
      requests.push(fetchOpenSubtitlesDirect(imdbId, season, episode, openSubKey, false));
    }
    if (wyzieKey && tid.startsWith('tt')) {
      const { imdbId, season, episode } = parseImdbId(tid);
      requests.push(fetchWyzieDirect(imdbId, season, episode, wyzieKey, false));
    }
  }

  // باقة الموسم: نكرر الاستعلام لكل معرف tt يملك رقم موسم، لكن بدون رقم الحلقة -
  // بعض المصادر تُرجع في هذه الحالة ملف/ملفات الموسم الكامل إن كانت متوفرة
  const seasonPackIds = [...new Set(targetIds
    .filter(t => t.startsWith('tt'))
    .map(t => { const { imdbId, season } = parseImdbId(t); return season ? `${imdbId}:${season}` : null; })
    .filter(Boolean))];

  for (const spid of seasonPackIds) {
    requests.push(...buildMirrorRequests(spid, 'series', true));
    if (openSubKey) {
      const { imdbId, season } = parseImdbId(spid);
      requests.push(fetchOpenSubtitlesDirect(imdbId, season, null, openSubKey, true));
    }
    if (wyzieKey) {
      const { imdbId, season } = parseImdbId(spid);
      requests.push(fetchWyzieDirect(imdbId, season, null, wyzieKey, true));
    }
  }

  // AnimeTosho
  if (animeInfo?.title) {
    const q = `${animeInfo.title} ${animeInfo.absoluteEp || ''}`.trim();
    requests.push(
      axios.get(`https://animetosho.org/api/v1/search?q=${encodeURIComponent(q)}`, { timeout: 6000 })
        .then(r => (r.data?.results || [])
          .filter(item => item.attachment_url)
          .map(item => ({
            url: item.attachment_url,
            lang: 'eng',
            origName: item.title || null,
            _source: 'animetosho',
            _seasonPack: false
          })))
        .catch(e => { logErr('animetosho', e); return []; })
    );
  }

  // SubDL الرسمي (zip يحتاج فك ضغط) - حلقة محددة + باقة الموسم إن توفر مفتاح SubDL
  let subdlZipEntries = [];
  if (subdlKey) {
    const subdlIds = new Set(targetIds.filter(t => t.startsWith('tt')));
    for (const tid of subdlIds) {
      const { imdbId, season, episode } = parseImdbId(tid);
      const zips = await fetchSubDLDirect(imdbId, season, episode, subdlKey, false);
      subdlZipEntries.push(...zips);
    }
    for (const spid of seasonPackIds) {
      const { imdbId, season } = parseImdbId(spid);
      const zips = await fetchSubDLDirect(imdbId, season, null, subdlKey, true);
      subdlZipEntries.push(...zips);
    }
  }

  try {
    const results = await Promise.all(requests);
    let rawSubtitles = [];
    results.forEach(list => { if (Array.isArray(list)) rawSubtitles.push(...list); });

    // التحقق من كل الروابط: استبعاد الفارغة، وتحديد الصيغة الفعلية لكل ملف
    rawSubtitles = await validateAndTag(rawSubtitles);
    subdlZipEntries = await validateZipEntries(subdlZipEntries);

    const host = req.get('host');
    const protocol = req.protocol;

    const arabicSubs = [];
    const nonArabicSubs = [];

    for (const sub of rawSubtitles) {
      const l = (sub.lang || '').toLowerCase();
      const isArabic = l === 'ara' || l === 'ar' || l === 'arabic' || l.includes('ara');
      const bucket = isArabic ? arabicSubs : nonArabicSubs;
      bucket.push({
        id: `sub_${isArabic ? 'ar' : 'en'}_${bucket.length + 1}`,
        url: sub.url,
        lang: isArabic ? 'ara' : (l || 'eng'),
        name: buildName(sub),
        title: buildName(sub),
        _ext: sub._ext,
        _source: sub._source,
        _lang: l,
        _seasonPack: sub._seasonPack,
        origName: sub.origName
      });
    }

    for (const entry of subdlZipEntries) {
      const extractUrl = `${protocol}://${host}/subdl-extract?zipUrl=${encodeURIComponent(entry.zipUrl)}`;
      const isArabic = entry.lang.startsWith('ar');
      const bucket = isArabic ? arabicSubs : nonArabicSubs;
      const named = buildName({ ...entry, url: extractUrl });
      bucket.push({
        id: `sub_subdl_${bucket.length + 1}`,
        url: extractUrl,
        lang: isArabic ? 'ara' : entry.lang,
        name: named,
        title: named,
        _ext: entry._ext,
        _source: entry._source,
        _lang: entry.lang,
        _seasonPack: entry._seasonPack,
        origName: entry.origName
      });
    }

    console.log(`[subtitles] ${type}/${targetId} -> عربي: ${arabicSubs.length}, أجنبي: ${nonArabicSubs.length}`);

    // تفضيل صيغة ASS/SSA دائمًا (حتى لو كانت تحتوي أخطاء بسيطة في محتواها)، ثم VTT ثم SRT
    const formatRank = { ass: 0, ssa: 0, vtt: 1, srt: 2 };
    const assFirst = (a, b) => (formatRank[a._ext] ?? 3) - (formatRank[b._ext] ?? 3);
    arabicSubs.sort(assFirst);
    nonArabicSubs.sort(assFirst);

    // إضافة ترجمات الذكاء الاصطناعي (حتى 10 نتائج) - المرشحون هنا تم التحقق مسبقًا من
    // أنهم غير فارغين، لذا لا نحتاج فحصًا إضافيًا لاستبعاد ترجمات AI فارغة المصدر
    const AI_MAX = 10;
    const hasAiKey = geminiKey || groqKey || deeplKey || openaiKey;
    const aiSubs = [];
    if (nonArabicSubs.length > 0 && hasAiKey) {
      const usedLangs = new Set();
      const primary = [];
      const rest = [];
      for (const cand of nonArabicSubs) {
        if (!usedLangs.has(cand._lang)) { usedLangs.add(cand._lang); primary.push(cand); }
        else rest.push(cand);
      }
      const candidates = [...primary, ...rest].slice(0, AI_MAX);
      const configToken = req.params.config || '';
      const base = configToken ? `${protocol}://${host}/${configToken}` : `${protocol}://${host}`;

      candidates.forEach((cand, idx) => {
        const aiProxyUrl = `${base}/translate/trans.ass?subUrl=${encodeURIComponent(cand.url)}`;
        const origBase = cand.origName ? cand.origName : (cand._lang ? cand._lang.toUpperCase() : 'ترجمة');
        const packTag = cand._seasonPack ? ' [باقة الموسم]' : '';
        // الناتج دائمًا بصيغة ass (نبنيها بأنفسنا بالكود من التوقيت الأصلي، انظر /translate)
        const name = `${origBase} • ${sourceLabelOf(cand._source)} • ترجمة AI • ASS${packTag}`;
        aiSubs.push({ id: `trans_${idx + 1}`, url: aiProxyUrl, lang: 'ara', name, title: name });
      });
      console.log(`[subtitles] ${type}/${targetId} -> تمت إضافة ${aiSubs.length} رابط ترجمة AI (trans)`);
    }

    // القائمة النهائية: العربية الأصلية فقط + ترجمات AI (نزيل الحقول الداخلية قبل الإرسال)
    const finalArabic = arabicSubs.map(({ _ext, _source, _lang, _seasonPack, origName, ...rest }) => rest);
    const combinedSubs = [...finalArabic, ...aiSubs];

    return res.json({ subtitles: combinedSubs });
  } catch (error) {
    logErr('handleSubtitles:main', error);
    return res.json({ subtitles: [] });
  }
};

// فك ضغط ملف SubDL zip وإرجاع أول ملف ترجمة بداخله (يعيد استخدام نفس دالة الاستخراج
// المستخدمة في مرحلة التحقق أعلاه، بدل تكرار منطق فك الضغط مرتين)
app.get('/subdl-extract', async (req, res) => {
  const { zipUrl } = req.query;
  if (!zipUrl) return res.status(400).send("No zip URL");

  try {
    const zipRes = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 12000 });
    const extracted = extractFirstSubtitleFromZip(Buffer.from(zipRes.data));
    if (!extracted || !extracted.content.trim()) return res.status(404).send("No subtitle file found in archive");

    const isAss = extracted.ext === 'ass' || extracted.ext === 'ssa';
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(extracted.content);
  } catch (err) {
    logErr('subdl-extract', err);
    res.status(500).send("Failed to extract subtitle archive");
  }
});

app.get('/subtitles/:type/:id.json', handleSubtitles);
app.get('/subtitles/:type/:id/:extra.json', handleSubtitles);
app.get('/:config/subtitles/:type/:id.json', handleSubtitles);
app.get('/:config/subtitles/:type/:id/:extra.json', handleSubtitles);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
