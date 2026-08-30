const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.opensubtitles.all",
  version: "5.0.0",
  name: "Universal OpenSubtitles & Gemini AI",
  description: "جلب كافة ترجمات OpenSubtitles بدون استثناء للأفلام والمسلسلات والأنمي مع دعم Gemini",
  resources: ["subtitles"],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "tmdb", "tvdb", "kitsu", "anilist", "mal"],
  catalogs: []
};

// صفحة التخصيص والإعدادات الكاملة
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Gemini & OpenSubtitles All</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #1e293b; padding: 30px; border-radius: 16px; width: 100%; max-width: 440px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; }
        h2 { color: #38bdf8; margin-top: 0; }
        label { display: block; text-align: right; margin: 12px 0 6px; font-size: 13px; color: #94a3b8; }
        input, select { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 14px; outline: none; }
        button { width: 100%; padding: 14px; margin-top: 20px; border-radius: 8px; border: none; background: #0284c7; color: #fff; font-weight: bold; cursor: pointer; font-size: 16px; }
        button:hover { background: #0369a1; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>إعدادات جلب الترجمات الشاملة</h2>
        
        <label>مفتاح Gemini API (اختياري):</label>
        <input type="text" id="apiKey" placeholder="AIzaSy...">

        <label>أقصى عدد للترجمات المجلوبة:</label>
        <select id="subLimit">
          <option value="20">20 ترجمة (سريع)</option>
          <option value="40">40 ترجمة (متوازن)</option>
          <option value="100" selected>100 ترجمة (شامل لجميع النسخ واللغات)</option>
          <option value="999">بدون حد (جلب الكل بالكامل)</option>
        </select>

        <label>تنسيق الترجمة المفضل:</label>
        <select id="format">
          <option value="ass">ASS (دقة ثابتة، محاذاة اللوحات)</option>
          <option value="srt">SRT (افتراضي)</option>
        </select>

        <button onclick="install()">تثبيت / تحديث في Nuvio</button>
      </div>

      <script>
        function install() {
          const key = document.getElementById('apiKey').value.trim();
          const limit = document.getElementById('subLimit').value;
          const format = document.getElementById('format').value;
          const config = btoa(JSON.stringify({ key: key, limit: parseInt(limit), format: format }));
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
  res.send(manifest);
});

// جلب كافة مصادر OpenSubtitles بدون أي فلترة أو استثناء
app.all(['/subtitles/*', '/:config/subtitles/*'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  let limit = 100;
  if (req.params.config) {
    try {
      const parsedConfig = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8'));
      if (parsedConfig.limit) limit = parsedConfig.limit;
    } catch (e) {}
  }

  const cleanPath = req.path.replace(/^\/[^/]+(?=\/subtitles)/, '');
  const parts = cleanPath.replace('/subtitles/', '').replace('.json', '').split('/');
  const type = parts[0] || 'movie';
  const rawId = decodeURIComponent(parts[1] || '');

  if (!rawId) return res.json({ subtitles: [] });

  let subtitles = [];
  const requests = [];

  // 1. خادم OpenSubtitles v3 الرئيسي
  requests.push(
    axios.get(`https://opensubtitles-v3.strem.io/subtitles/${type}/${rawId}.json`, { timeout: 4000 })
      .then(r => r.data?.subtitles || []).catch(() => [])
  );

  // 2. خوادم ترجمات الأنمي المفتوحة لمطابقة معرفات kitsu/anilist مع OpenSubtitles
  if (rawId.startsWith('kitsu') || rawId.startsWith('anilist') || rawId.startsWith('mal')) {
    requests.push(
      axios.get(`https://anime-subtitles.strem.fun/subtitles/${type}/${rawId}.json`, { timeout: 4000 })
        .then(r => r.data?.subtitles || []).catch(() => [])
    );
  }

  // 3. خوادم التحويل لمعرفات TMDB و TVDB إلى ترجمات OpenSubtitles المباشرة
  if (rawId.startsWith('tmdb') || rawId.startsWith('tvdb')) {
    requests.push(
      axios.get(`https://subdl-stremio.vercel.app/subtitles/${type}/${rawId}.json`, { timeout: 4000 })
        .then(r => r.data?.subtitles || []).catch(() => [])
    );
  }

  try {
    const results = await Promise.all(requests);
    results.forEach(list => {
      if (Array.isArray(list)) subtitles.push(...list);
    });

    // إزالة الروابط المكررة تماماً مع الإبقاء على كافة اللغات والنسخ
    const uniqueSubs = [];
    const seenUrls = new Set();
    for (const sub of subtitles) {
      if (sub && sub.url && !seenUrls.has(sub.url)) {
        seenUrls.add(sub.url);
        uniqueSubs.push(sub);
      }
    }

    // إرسال جميع الترجمات حسب الحد المختار
    return res.json({ subtitles: uniqueSubs.slice(0, limit) });
  } catch (error) {
    return res.json({ subtitles: [] });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
