const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.meta.subtitles",
  version: "11.0.0",
  name: "Universal Meta Subtitles & Gemini AI",
  description: "جلب الترجمات الشاملة للأفلام والمسلسلات والأنمي مع الترجمة الفورية بالذكاء الاصطناعي",
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

// صفحة التخصيص
app.get(['/', '/configure'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>إعدادات محرك الترجمات الشامل</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #1e293b; padding: 25px; border-radius: 16px; width: 100%; max-width: 480px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; }
        h2 { color: #38bdf8; margin-top: 0; font-size: 20px; }
        label { display: block; text-align: right; margin: 10px 0 4px; font-size: 13px; color: #94a3b8; }
        input, select { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 13px; outline: none; }
        input:focus, select:focus { border-color: #38bdf8; }
        button { width: 100%; padding: 13px; margin-top: 20px; border-radius: 8px; border: none; background: #0284c7; color: #fff; font-weight: bold; cursor: pointer; font-size: 15px; }
        button:hover { background: #0369a1; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>إعدادات المعرفات ومفاتيح الـ API</h2>
        
        <label>مفتاح Gemini API (للترجمة الفورية):</label>
        <input type="text" id="geminiKey" placeholder="AIzaSy...">

        <label>مفتاح TMDB API (اختياري):</label>
        <input type="text" id="tmdbKey" placeholder="TMDB API Key">

        <label>مفتاح SubDL API (اختياري):</label>
        <input type="text" id="subdlKey" placeholder="SubDL API Key">

        <label>أقصى عدد للترجمات المجلوبة:</label>
        <select id="subLimit">
          <option value="20">20 ترجمة (سريع)</option>
          <option value="40" selected>40 ترجمة (متوازن ومثالي)</option>
          <option value="100">100 ترجمة (شامل لجميع النسخ)</option>
          <option value="999">بدون حد (جلب الكل)</option>
        </select>

        <label>تنسيق الترجمة المفضل لـ Gemini:</label>
        <select id="format">
          <option value="ass">ASS (دقة ثابتة، محاذاة اللوحات)</option>
          <option value="srt">SRT (افتراضي)</option>
        </select>

        <button onclick="install()">تثبيت / تحديث في Nuvio</button>
      </div>

      <script>
        function install() {
          const geminiKey = document.getElementById('geminiKey').value.trim();
          const tmdbKey = document.getElementById('tmdbKey').value.trim();
          const subdlKey = document.getElementById('subdlKey').value.trim();
          const limit = document.getElementById('subLimit').value;
          const format = document.getElementById('format').value;

          const config = btoa(JSON.stringify({
            geminiKey,
            tmdbKey,
            subdlKey,
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

// ترجمة Gemini الفورية
app.get('/translate', async (req, res) => {
  const { subUrl, key, format } = req.query;
  if (!subUrl) return res.status(400).send("No subtitle URL");

  try {
    const subRes = await axios.get(subUrl, { responseType: 'text', timeout: 8000 });
    const originalText = subRes.data;

    if (!key) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(originalText);
    }

    const ai = new GoogleGenAI({ apiKey: key });
    const prompt = `Translate this subtitle into accurate Arabic. Preserve all timestamps and subtitle IDs strictly:\n\n${originalText.slice(0, 30000)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: prompt,
    });

    const translatedText = response.text || originalText;
    res.setHeader('Content-Type', format === 'ass' ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(translatedText);
  } catch (err) {
    res.redirect(subUrl);
  }
});

// حل معرف Kitsu إلى IMDb والحلقة
async function resolveKitsu(kitsuId, ep) {
  try {
    const res = await axios.get(`https://anime-kitsu.strem.fun/meta/anime/kitsu:${kitsuId}.json`, { timeout: 3000 }).catch(() => null);
    if (res?.data?.meta?.imdb_id) {
      return ep ? `${res.data.meta.imdb_id}:1:${ep}` : res.data.meta.imdb_id;
    }
  } catch (e) {}
  return null;
}

// معالج جلب الترجمات الشامل الملتزم بالبروتوكول
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
  let geminiKey = '';
  let prefFormat = 'ass';

  if (req.params.config) {
    try {
      const parsedConfig = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8'));
      if (parsedConfig.limit) limit = parsedConfig.limit;
      if (parsedConfig.geminiKey) geminiKey = parsedConfig.geminiKey;
      if (parsedConfig.format) prefFormat = parsedConfig.format;
    } catch (e) {}
  }

  const clientHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Accept': 'application/json'
  };

  const targetIds = [targetId];

  if (targetId.startsWith('kitsu:')) {
    const parts = targetId.split(':');
    const resolved = await resolveKitsu(parts[1], parts[2] || '1');
    if (resolved) targetIds.push(resolved);
  }

  const requests = [];

  for (const tid of targetIds) {
    const fetchType = (tid.startsWith('kitsu') || type === 'anime') ? 'series' : type;

    // OpenSubtitles v3
    requests.push(
      axios.get(`https://opensubtitles-v3.strem.io/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 4500 })
        .then(r => r.data?.subtitles || []).catch(() => [])
    );

    // SubDL Mirror
    requests.push(
      axios.get(`https://subdl-stremio.vercel.app/subtitles/${fetchType}/${tid}.json`, { headers: clientHeaders, timeout: 4500 })
        .then(r => r.data?.subtitles || []).catch(() => [])
    );

    // خوادم الأنمي المخصصة
    if (tid.startsWith('kitsu') || tid.startsWith('anilist') || fetchType === 'series') {
      requests.push(
        axios.get(`https://anime-subtitles.strem.fun/subtitles/series/${tid}.json`, { headers: clientHeaders, timeout: 4500 })
          .then(r => r.data?.subtitles || []).catch(() => [])
      );
    }
  }

  try {
    const results = await Promise.all(requests);
    let subtitles = [];
    results.forEach(list => {
      if (Array.isArray(list)) subtitles.push(...list);
    });

    // إزالة التكرار وضبط معايير البروتوكول الصارمة
    const uniqueSubs = [];
    const seenUrls = new Set();

    for (let i = 0; i < subtitles.length; i++) {
      const sub = subtitles[i];
      if (sub && sub.url && !seenUrls.has(sub.url)) {
        seenUrls.add(sub.url);
        
        // تنقية كود اللغة ليكون متوافقاً مع المشغل (ara / eng)
        let standardLang = (sub.lang || 'ara').toLowerCase();
        if (standardLang === 'ar' || standardLang === 'arabic') standardLang = 'ara';
        if (standardLang === 'en' || standardLang === 'english') standardLang = 'eng';

        uniqueSubs.push({
          id: `sub_${uniqueSubs.length + 1}`,
          url: sub.url,
          lang: standardLang
        });
      }
    }

    // إضافة ترجمة Gemini AI برابط مباشر وكود لغة قياسي معتمد
    if (uniqueSubs.length > 0 && geminiKey) {
      const bestSource = uniqueSubs.find(s => s.lang === 'eng') || uniqueSubs[0];
      const host = req.get('host');
      const protocol = req.protocol;
      const aiProxyUrl = `${protocol}://${host}/translate?subUrl=${encodeURIComponent(bestSource.url)}&key=${geminiKey}&format=${prefFormat}`;

      uniqueSubs.unshift({
        id: `gemini_ai_sub_1`,
        url: aiProxyUrl,
        lang: 'ara' // لغة عربية قياسية ليتعرف عليها المشغل فوراً
      });
    }

    return res.json({ subtitles: uniqueSubs.slice(0, limit) });
  } catch (error) {
    return res.json({ subtitles: [] });
  }
};

app.get('/subtitles/:type/:id.json', handleSubtitles);
app.get('/subtitles/:type/:id/:extra.json', handleSubtitles);
app.get('/:config/subtitles/:type/:id.json', handleSubtitles);
app.get('/:config/subtitles/:type/:id/:extra.json', handleSubtitles);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
