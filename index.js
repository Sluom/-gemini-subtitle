const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.ultimate.allsubtitles",
  version: "8.0.0",
  name: "Mega Subtitles Hub & Gemini AI",
  description: "جلب الترجمات الشاملة من (Subscene, SubDL, OpenSubtitles, YTS, Addic7ed, Podnapisi, Kitsunekko, Subanime, TVsubtitles) مع دعم Gemini",
  resources: ["subtitles"],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "kitsu", "tmdb", "tvdb", "anilist", "mal"],
  catalogs: []
};

// صفحة التخصيص لجميع المصادر ومفاتيح الـ API
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
        <h2>إعدادات كافة مواقع الترجمة العربية و Gemini</h2>
        
        <label>مفتاح Gemini API (للترجمة الفورية):</label>
        <input type="text" id="geminiKey" placeholder="AIzaSy...">

        <label>مفتاح SubDL API (اختياري لجلب مباشر أسرع):</label>
        <input type="text" id="subdlKey" placeholder="SubDL API Key">

        <label>مفتاح OpenSubtitles.com API (اختياري):</label>
        <input type="text" id="openSubKey" placeholder="OpenSubtitles API Key">

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
          const subdlKey = document.getElementById('subdlKey').value.trim();
          const openSubKey = document.getElementById('openSubKey').value.trim();
          const limit = document.getElementById('subLimit').value;
          const format = document.getElementById('format').value;

          const config = btoa(JSON.stringify({
            geminiKey,
            subdlKey,
            openSubKey,
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
  const { subUrl, key, format } = req.query;
  if (!subUrl) return res.status(400).send("No subtitle URL");

  try {
    const subRes = await axios.get(subUrl, { responseType: 'text', timeout: 7000 });
    const originalText = subRes.data;

    if (!key) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(originalText);
    }

    const ai = new GoogleGenAI({ apiKey: key });
    const prompt = `Translate this subtitle into accurate Arabic with perfect timing. Maintain all original timestamps and formatting:\n\n${originalText.slice(0, 30000)}`;

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

// معالج جلب الترجمات الشامل من كافة المواقع
const handleSubtitles = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { type, id, extra } = req.params;
  let targetId = id;
  if (extra && extra.endsWith('.json')) {
    targetId = `${id}/${extra.replace('.json', '')}`;
  } else if (targetId.endsWith('.json')) {
    targetId = targetId.replace('.json', '');
  }

  let limit = 40;
  let geminiKey = '';
  let subdlKey = '';
  let openSubKey = '';
  let prefFormat = 'ass';

  if (req.params.config) {
    try {
      const parsedConfig = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8'));
      if (parsedConfig.limit) limit = parsedConfig.limit;
      if (parsedConfig.geminiKey) geminiKey = parsedConfig.geminiKey;
      if (parsedConfig.subdlKey) subdlKey = parsedConfig.subdlKey;
      if (parsedConfig.openSubKey) openSubKey = parsedConfig.openSubKey;
      if (parsedConfig.format) prefFormat = parsedConfig.format;
    } catch (e) {}
  }

  const clientHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Accept': 'application/json'
  };

  const requests = [];

  // 1. OpenSubtitles v3 & Community
  requests.push(
    axios.get(`https://opensubtitles-v3.strem.io/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
    axios.get(`https://opensubtitles.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
  );

  // 2. SubDL (API أو السيرفر المباشر)
  if (subdlKey) {
    requests.push(
      axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${subdlKey}&imdb_id=${targetId}&languages=ar,en`, { timeout: 4000 })
        .then(r => (r.data?.subtitles || []).map(s => ({ id: `subdl_${s.id}`, url: `https://dl.subdl.com${s.url}`, lang: s.language === 'Arabic' ? 'ara' : 'eng' }))).catch(() => [])
    );
  } else {
    requests.push(
      axios.get(`https://subdl-stremio.vercel.app/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
    );
  }

  // 3. خوادم ومصادر ترجمات Subscene و Addic7ed و Podnapisi و TVsubtitles
  requests.push(
    axios.get(`https://subscene.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
    axios.get(`https://addic7ed.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
    axios.get(`https://podnapisi.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
  );

  // 4. خوادم ترجمات YTS / YIFY
  requests.push(
    axios.get(`https://yifysubtitles.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
  );

  // 5. مصادر الأنمي المتخصصة (Kitsunekko, Subanime, Jimaku, Anime-Subtitles)
  if (targetId.startsWith('kitsu') || targetId.startsWith('anilist') || targetId.startsWith('mal')) {
    requests.push(
      axios.get(`https://anime-subtitles.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
      axios.get(`https://kitsunekko-subtitles.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
      axios.get(`https://subanime.strem.fun/subtitles/${type}/${targetId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
    );
  }

  try {
    const results = await Promise.all(requests);
    let subtitles = [];
    results.forEach(list => {
      if (Array.isArray(list)) subtitles.push(...list);
    });

    // إزالة التكرار
    const uniqueSubs = [];
    const seenUrls = new Set();
    for (const sub of subtitles) {
      if (sub && sub.url && !seenUrls.has(sub.url)) {
        seenUrls.add(sub.url);
        uniqueSubs.push(sub);
      }
    }

    // إدراج خيار الترجمة الفورية عبر Gemini في أعلى القائمة
    if (uniqueSubs.length > 0) {
      const bestSource = uniqueSubs.find(s => s.lang === 'eng' || s.lang === 'en') || uniqueSubs[0];
      const host = req.get('host');
      const protocol = req.protocol;
      const aiProxyUrl = `${protocol}://${host}/translate?subUrl=${encodeURIComponent(bestSource.url)}&key=${geminiKey}&format=${prefFormat}`;

      uniqueSubs.unshift({
        id: `gemini_ai_translated`,
        url: aiProxyUrl,
        lang: `⭐ [Gemini AI] ترجمة عربية احترافية (${prefFormat.toUpperCase()})`
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
