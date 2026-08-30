const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.multisource.gemini.subtitles",
  version: "2.0.0",
  name: "Multi-Source & Gemini Subtitles",
  description: "ترجمات مدمجة من مختلف المصادر العالمية مع دعم ترجمة Gemini الذكية بصيغة ASS",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: []
};

// صفحة التخصيص الرئيسية
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>إعدادات الترجمة</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: #1e293b; padding: 30px; border-radius: 16px; width: 100%; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; }
        h2 { color: #38bdf8; margin-bottom: 20px; }
        input, select, button { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #334155; box-sizing: border-box; font-size: 14px; }
        input, select { background: #0f172a; color: #fff; }
        button { background: #0284c7; color: #fff; border: none; font-weight: bold; cursor: pointer; margin-top: 15px; }
        button:hover { background: #0369a1; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>إعدادات Gemini Subtitles</h2>
        <input type="text" id="apiKey" placeholder="مفتاح Gemini API (اختياري)">
        <select id="format">
          <option value="ass">ASS (دقة ثابتة، محاذاة اللوحات)</option>
          <option value="srt">SRT (افتراضي)</option>
        </select>
        <button onclick="install()">تثبيت / تحديث في Nuvio</button>
      </div>
      <script>
        function install() {
          const manifestUrl = window.location.origin + '/manifest.json';
          window.location.href = 'nuvio://' + manifestUrl.replace(/^https?:\\/\\//, '');
        }
      </script>
    </body>
    </html>
  `);
});

// مسار المانيفست لتطبيق Nuvio
app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(manifest);
});

// مسار جلب الترجمات من مختلف المصادر
app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  let subtitles = [];

  try {
    const openSubRes = await axios.get(\`https://opensubtitles-v3.strem.io/subtitles/\${type}/\${id}.json\`).catch(() => null);
    if (openSubRes && openSubRes.data && openSubRes.data.subtitles) {
      subtitles.push(...openSubRes.data.subtitles);
    }

    const subdlRes = await axios.get(\`https://subdl-stremio.vercel.app/subtitles/\${type}/\${id}.json\`).catch(() => null);
    if (subdlRes && subdlRes.data && subdlRes.data.subtitles) {
      subtitles.push(...subdlRes.data.subtitles);
    }
  } catch (error) {
    console.error("Error fetching subtitles:", error);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send({ subtitles: subtitles });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
