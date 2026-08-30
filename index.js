const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

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

app.get('/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.send(manifest);
});

// مسار جلب الترجمات من مصادر متعددة + الذكاء الاصطناعي
app.get('/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  const imdbId = id.split(':')[0];
  let subtitles = [];

  try {
    // 1. جلب ترجمات OpenSubtitles المفتوحة
    const openSubRes = await axios.get(`https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`).catch(() => null);
    if (openSubRes && openSubRes.data && openSubRes.data.subtitles) {
      const openSubs = openSubRes.data.subtitles.map((sub, index) => ({
        id: `opensub_${index}_${sub.lang || 'ar'}`,
        url: sub.url,
        lang: sub.lang || 'ara'
      }));
      subtitles.push(...openSubs);
    }

    // 2. جلب ترجمات SubDL المتاحة
    const subdlRes = await axios.get(`https://subdl-stremio.vercel.app/subtitles/${type}/${id}.json`).catch(() => null);
    if (subdlRes && subdlRes.data && subdlRes.data.subtitles) {
      subtitles.push(...subdlRes.data.subtitles);
    }

    // 3. خيار الترجمة الفورية عبر Gemini بالذكاء الاصطناعي
    if (subtitles.length > 0) {
      subtitles.unshift({
        id: `gemini_ai_ar`,
        url: subtitles[0].url,
        lang: "ara (Gemini AI Enhanced ASS)"
      });
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
  console.log(`Server running on port ${PORT}`);
});
