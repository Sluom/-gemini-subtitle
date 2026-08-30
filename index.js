const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// واجهة صفحة إدخال المفتاح والتخصيص
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>إعدادات Gemini Subtitles</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: #1e293b; padding: 30px; border-radius: 16px; width: 100%; max-width: 440px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); text-align: center; border: 1px solid #334155; }
        h2 { color: #38bdf8; margin-top: 0; font-size: 22px; }
        label { display: block; text-align: right; margin: 12px 0 6px; font-size: 13px; color: #94a3b8; }
        input, select { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 14px; outline: none; }
        input:focus, select:focus { border-color: #38bdf8; }
        button { width: 100%; padding: 14px; margin-top: 20px; border-radius: 8px; border: none; background: #0284c7; color: #fff; font-weight: bold; cursor: pointer; font-size: 16px; transition: 0.2s; }
        button:hover { background: #0369a1; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>إعدادات Gemini Subtitles</h2>
        
        <label>مفتاح Gemini API:</label>
        <input type="text" id="apiKey" placeholder="AIzaSy...">

        <label>تنسيق الترجمة المفضل:</label>
        <select id="format">
          <option value="ass">ASS (دقة ثابتة، محاذاة اللوحات، عدم تداخل الأسطر)</option>
          <option value="srt">SRT (افتراضي)</option>
        </select>

        <button onclick="install()">تثبيت / تحديث في Nuvio</button>
      </div>

      <script>
        function install() {
          const key = document.getElementById('apiKey').value.trim();
          const format = document.getElementById('format').value;
          const config = btoa(JSON.stringify({ key: key, format: format }));
          const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
          window.location.href = 'nuvio://' + manifestUrl.replace(/^https?:\\/\\//, '');
        }
      </script>
    </body>
    </html>
  `);
});

// مسار المانيفست العام
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send({
    id: "org.nuvio.gemini.subtitles",
    version: "2.5.0",
    name: "Gemini AI & Multi-Source Subtitles",
    description: "جلب الترجمات العالمية ودعم ترجمة Gemini المباشرة",
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
  });
});

// مسار جلب وعرض الترجمات
app.all(['/subtitles/*', '/:config/subtitles/*'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const cleanPath = req.path.replace(/^\/[^/]+(?=\/subtitles)/, '');
  const parts = cleanPath.replace('/subtitles/', '').replace('.json', '').split('/');
  const type = parts[0] || 'movie';
  const id = parts[1] || '';

  if (!id) return res.json({ subtitles: [] });

  let subtitles = [];
  try {
    const openSubRes = await axios.get(`https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`, { timeout: 4000 }).catch(() => null);
    if (openSubRes && openSubRes.data && Array.isArray(openSubRes.data.subtitles)) {
      subtitles.push(...openSubRes.data.subtitles);
    }
    return res.json({ subtitles: subtitles });
  } catch (error) {
    return res.json({ subtitles: [] });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
