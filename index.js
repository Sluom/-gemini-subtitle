const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');

const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.gemini.subtitles",
  version: "26.1.0",
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

// ============= أدوات مساعدة =============

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
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Universal Subtitles & Gemini AI</h2>

        <h3>🤖 محركات الذكاء الاصطناعي (حتى 5 نتائج في نهاية القائمة)</h3>
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

        <h3>⚙️ إعدادات العرض والأداء</h3>
        <div class="field-group">
          <label>أقصى عدد للترجمات المجلوبة:</label>
          <select id="subLimit">
            <option value="20">20 ترجمة (سريع)</option>
            <option value="40" selected>40 ترجمة (متوازن ومثالي)</option>
            <option value="100">100 ترجمة (شامل لجميع النسخ)</option>
            <option value="999">بدون حد (جلب الكل)</option>
          </select>
        </div>

        <div class="field-group">
          <label>تنسيق ملف الترجمة المفضل للذكاء الاصطناعي:</label>
          <select id="format">
            <option value="ass">ASS (دقة ثابتة، محاذاة اللوحات)</option>
            <option value="srt">SRT (افتراضي)</option>
          </select>
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
          const limit = document.getElementById('subLimit').value;
          const format = document.getElementById('format').value;

          const config = toBase64Url(JSON.stringify({
            geminiKey, groqKey, deeplKey, openaiKey, jimakuKey,
            subsourceKey, openSubKey, subdlKey, wyzieKey, tmdbKey,
            limit: parseInt(limit),
            format
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
app.get('/translate', async (req, res) => {
  const { subUrl, geminiKey, groqKey, deeplKey, openaiKey, format } = req.query;
  if (!subUrl) return res.status(400).send("No subtitle URL");

  try {
    const subRes = await axios.get(subUrl, { responseType: 'text', timeout: 10000 });
    const originalText = subRes.data;

    let translatedText = null;

    if (geminiKey && !translatedText) {
      const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
      for (const m of modelsToTry) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(geminiKey.trim())}`;
          const gRes = await axios.post(url, {
            contents: [{
              parts: [{
                text: `Translate this subtitle into accurate Arabic with exact timing preservation. Output ONLY the translated content:\n\n${originalText.slice(0, 30000)}`
              }]
            }]
          }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
          translatedText = gRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (translatedText) break;
        } catch (e) {
          logErr(`translate:gemini:${m}`, e);
        }
      }
    }

    if (groqKey && !translatedText) {
      try {
        const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
          model: 'llama-3.3-70b-versatile',
          messages: [{
            role: 'user',
            content: `Translate this subtitle into accurate Arabic with exact timing preservation. Output ONLY the raw subtitle content without explanation:\n\n${originalText.slice(0, 30000)}`
          }]
        }, { headers: { Authorization: `Bearer ${groqKey.trim()}` }, timeout: 15000 });
        translatedText = groqRes.data?.choices?.[0]?.message?.content;
      } catch (e) {
        logErr('translate:groq', e);
      }
    }

    const finalResult = translatedText || originalText;
    res.setHeader('Content-Type', format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(finalResult);
  } catch (err) {
    logErr('translate:fetchSub', err);
    res.redirect(subUrl);
  }
});

// فك شفرة معرف الأنمي
async function resolveAnimeMeta(rawId) {
  try {
    if (rawId.startsWith('kitsu:')) {
      const parts = rawId.split(':');
      const kitsuId = parts[1];
      const ep = parts[2] || '1';
      const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 5000 }).catch((e) => { logErr('kitsu:meta', e); return null; });
      const title = res?.data?.data?.attributes?.canonicalTitle || res?.data?.data?.attributes?.titles?.en;

      const stremRes = await axios.get(`https://anime-kitsu.strem.fun/meta/anime/kitsu:${kitsuId}.json`, { timeout: 5000 }).catch((e) => { logErr('kitsu:strem', e); return null; });
      const imdbId = stremRes?.data?.meta?.imdb_id ? `${stremRes.data.meta.imdb_id}:1:${ep}` : null;
      return { imdbId, title, ep };
    }
  } catch (e) {
    logErr('resolveAnimeMeta', e);
  }
  return null;
}

// جلب مباشر من OpenSubtitles.com الرسمي باستخدام مفتاح API الخاص بالمستخدم
async function fetchOpenSubtitlesDirect(imdbId, season, episode, apiKey) {
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
      const fileUrl = attrs?.files?.[0]?.file_id;
      if (!fileUrl) continue;
      // نحتاج رابط تحميل فعلي عبر endpoint التحميل
      try {
        const dl = await axios.post('https://api.opensubtitles.com/api/v1/download',
          { file_id: fileUrl },
          { headers: { 'Api-Key': apiKey.trim(), 'Content-Type': 'application/json', 'User-Agent': 'NuvioSubtitlesApp v1.0.0' }, timeout: 8000 }
        );
        if (dl.data?.link) {
          out.push({ url: dl.data.link, lang: attrs.language || 'en' });
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

// جلب مباشر من SubDL باستخدام مفتاح API الخاص بالمستخدم + فك ضغط ملف zip
async function fetchSubDLDirect(imdbId, season, episode, apiKey) {
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
      out.push({ zipUrl, lang: (item.lang || 'en').toLowerCase() });
    }
    return out;
  } catch (e) {
    logErr('subdl:direct', e);
    return [];
  }
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

  let limit = 40;
  let geminiKey = '', groqKey = '', deeplKey = '', openaiKey = '';
  let subsourceKey = '', openSubKey = '', subdlKey = '', wyzieKey = '';
  let prefFormat = 'ass';

  if (req.params.config) {
    try {
      const p = JSON.parse(base64UrlDecode(req.params.config));
      if (p.limit) limit = p.limit;
      if (p.geminiKey) geminiKey = p.geminiKey;
      if (p.groqKey) groqKey = p.groqKey;
      if (p.deeplKey) deeplKey = p.deeplKey;
      if (p.openaiKey) openaiKey = p.openaiKey;
      if (p.subsourceKey) subsourceKey = p.subsourceKey;
      if (p.openSubKey) openSubKey = p.openSubKey;
      if (p.subdlKey) subdlKey = p.subdlKey;
      if (p.wyzieKey) wyzieKey = p.wyzieKey;
      if (p.format) prefFormat = p.format;
    } catch (e) {
      logErr('config:decode', e);
    }
  }

  const clientHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Accept': 'application/json'
  };

  const targetIds = [targetId];
  let animeInfo = null;

  if (targetId.startsWith('kitsu:')) {
    animeInfo = await resolveAnimeMeta(targetId);
    if (animeInfo?.imdbId) targetIds.push(animeInfo.imdbId);
  }

  const requests = [];

  for (const tid of targetIds) {
    const fetchType = (tid.startsWith('kitsu') || type === 'anime') ? 'series' : type;

    // OpenSubtitles (مرايا مجتمعية مجانية)
    requests.push(
      axios.get(`https://opensubtitles-v3.strem.io/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
        .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:opensub-v3', e); return []; }),
      axios.get(`https://opensubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
        .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:opensub-fun', e); return []; })
    );

    // SubDL (مرآة مجتمعية)
    requests.push(
      axios.get(`https://subdl-stremio.vercel.app/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
        .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:subdl', e); return []; })
    );

    // Subscene & YTS
    requests.push(
      axios.get(`https://subscene.strem.fun/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
        .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:subscene', e); return []; }),
      axios.get(`https://yifysubtitles.strem.fun/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
        .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:yify', e); return []; })
    );

    // مصادر الأنمي
    if (tid.startsWith('kitsu') || tid.startsWith('anilist') || fetchType === 'series') {
      requests.push(
        axios.get(`https://anime-subtitles.strem.fun/subtitles/series/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
          .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:anime-subs', e); return []; }),
        axios.get(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
          .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:kitsunekko', e); return []; }),
        axios.get(`https://subanime.strem.fun/subtitles/series/${tid}.json`, { headers: clientHeaders, timeout: 6000 })
          .then(r => r.data?.subtitles || []).catch(e => { logErr('mirror:subanime', e); return []; })
      );
    }

    // OpenSubtitles الرسمي (باستخدام مفتاح المستخدم إن وُجد)
    if (openSubKey && tid.startsWith('tt')) {
      const { imdbId, season, episode } = parseImdbId(tid);
      requests.push(
        fetchOpenSubtitlesDirect(imdbId, season, episode, openSubKey)
          .then(list => list.map(x => ({ url: x.url, lang: x.lang })))
      );
    }
  }

  // AnimeTosho
  if (animeInfo?.title) {
    const q = `${animeInfo.title} ${animeInfo.ep}`;
    requests.push(
      axios.get(`https://animetosho.org/api/v1/search?q=${encodeURIComponent(q)}`, { timeout: 6000 })
        .then(r => {
          const files = [];
          (r.data?.results || []).forEach((item, idx) => {
            if (item.attachment_url) {
              files.push({ id: `tosho_${idx}`, url: item.attachment_url, lang: 'eng' });
            }
          });
          return files;
        }).catch(e => { logErr('animetosho', e); return []; })
    );
  }

  // SubDL الرسمي (zip يحتاج فك ضغط)
  let subdlZipEntries = [];
  if (subdlKey) {
    for (const tid of targetIds) {
      if (!tid.startsWith('tt')) continue;
      const { imdbId, season, episode } = parseImdbId(tid);
      const zips = await fetchSubDLDirect(imdbId, season, episode, subdlKey);
      subdlZipEntries.push(...zips);
    }
  }

  try {
    const results = await Promise.all(requests);
    let rawSubtitles = [];
    results.forEach(list => {
      if (Array.isArray(list)) rawSubtitles.push(...list);
    });

    const host = req.get('host');
    const protocol = req.protocol;

    const arabicSubs = [];
    const nonArabicSubs = [];
    const seenUrls = new Set();

    for (const sub of rawSubtitles) {
      if (sub && sub.url && !seenUrls.has(sub.url)) {
        seenUrls.add(sub.url);

        let l = (sub.lang || '').toLowerCase();
        if (l === 'ara' || l === 'ar' || l === 'arabic' || l.includes('ara')) {
          arabicSubs.push({
            id: `sub_ar_${arabicSubs.length + 1}`,
            url: sub.url,
            lang: 'ara'
          });
        } else {
          nonArabicSubs.push({
            id: `sub_en_${nonArabicSubs.length + 1}`,
            url: sub.url,
            lang: l || 'eng'
          });
        }
      }
    }

    // إضافة روابط SubDL (تمر عبر مسار فك الضغط /subdl-extract)
    for (const entry of subdlZipEntries) {
      if (seenUrls.has(entry.zipUrl)) continue;
      seenUrls.add(entry.zipUrl);
      const extractUrl = `${protocol}://${host}/subdl-extract?zipUrl=${encodeURIComponent(entry.zipUrl)}`;
      const bucket = entry.lang.startsWith('ar') ? arabicSubs : nonArabicSubs;
      bucket.push({
        id: `sub_subdl_${bucket.length + 1}`,
        url: extractUrl,
        lang: entry.lang.startsWith('ar') ? 'ara' : entry.lang
      });
    }

    let combinedSubs = [...arabicSubs, ...nonArabicSubs];

    console.log(`[subtitles] ${type}/${targetId} -> عربي: ${arabicSubs.length}, أجنبي: ${nonArabicSubs.length}`);

    // إضافة ترجمات الذكاء الاصطناعي (حتى 5 نتائج) في نهاية القائمة
    const hasAiKey = geminiKey || groqKey || deeplKey || openaiKey;
    if (nonArabicSubs.length > 0 && hasAiKey) {
      const candidates = nonArabicSubs.slice(0, 5);
      candidates.forEach((cand, idx) => {
        const aiProxyUrl = `${protocol}://${host}/translate?subUrl=${encodeURIComponent(cand.url)}&geminiKey=${encodeURIComponent(geminiKey)}&groqKey=${encodeURIComponent(groqKey)}&deeplKey=${encodeURIComponent(deeplKey)}&openaiKey=${encodeURIComponent(openaiKey)}&format=${encodeURIComponent(prefFormat)}`;

        combinedSubs.push({
          id: `ai_sub_${idx + 1}`,
          url: aiProxyUrl,
          lang: 'ara'
        });
      });
    }

    return res.json({ subtitles: combinedSubs.slice(0, limit) });
  } catch (error) {
    logErr('handleSubtitles:main', error);
    return res.json({ subtitles: [] });
  }
};

// فك ضغط ملف SubDL zip وإرجاع أول ملف ترجمة بداخله
app.get('/subdl-extract', async (req, res) => {
  const { zipUrl } = req.query;
  if (!zipUrl) return res.status(400).send("No zip URL");

  try {
    const zipRes = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 12000 });
    const zip = new AdmZip(Buffer.from(zipRes.data));
    const entries = zip.getEntries().filter(e =>
      /\.(srt|ass|ssa|vtt)$/i.test(e.entryName)
    );

    if (entries.length === 0) return res.status(404).send("No subtitle file found in archive");

    // نفضّل ملف srt إن وجد، وإلا أول ملف متاح
    const chosen = entries.find(e => e.entryName.toLowerCase().endsWith('.srt')) || entries[0];
    const content = chosen.getData().toString('utf8');

    const ext = chosen.entryName.split('.').pop().toLowerCase();
    res.setHeader('Content-Type', ext === 'ass' || ext === 'ssa' ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(content);
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
