const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.meta.subtitles",
  version: "10.0.0",
  name: "Universal Meta Subtitles & Gemini AI",
  description: "جلب الترجمات الشاملة بتحويل معرفات Kitsu, AniList, TMDB, TVDB, IMDb مع دعم Gemini",
  resources: ["subtitles"],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "kitsu", "tmdb", "tvdb", "anilist", "mal"],
  catalogs: []
};

// صفحة التخصيص لجميع المفاتيح والإعدادات
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

        <label>مفتاح TMDB API (اختياري لتحويل دقيق وسريع):</label>
        <input type="text" id="tmdbKey" placeholder="TMDB Read Access Token / API Key">

        <label>مفتاح TVDB API (اختياري):</label>
        <input type="text" id="tvdbKey" placeholder="TVDB API Key">

        <label>مفتاح SubDL API (اختياري):</label>
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
          const tmdbKey = document.getElementById('tmdbKey').value.trim();
          const tvdbKey = document.getElementById('tvdbKey').value.trim();
          const subdlKey = document.getElementById('subdlKey').value.trim();
          const openSubKey = document.getElementById('openSubKey').value.trim();
          const limit = document.getElementById('subLimit').value;
          const format = document.getElementById('format').value;

          const config = btoa(JSON.stringify({
            geminiKey,
            tmdbKey,
            tvdbKey,
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
    const prompt = `Translate this subtitle into accurate, natural Arabic with exact timing preservation. Output ONLY the translated subtitle content without explanations:\n\n${originalText.slice(0, 30000)}`;

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

// دوال تحويل المعرفات التلقائية (Mapping Resolvers)
async function resolveAnimeMeta(rawId) {
  try {
    if (rawId.startsWith('kitsu:')) {
      const parts = rawId.split(':');
      const kitsuId = parts[1];
      const ep = parts[2] || '1';
      const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 3500 });
      const title = res.data?.data?.attributes?.canonicalTitle || res.data?.data?.attributes?.titles?.en;
      
      const stremRes = await axios.get(`https://anime-kitsu.strem.fun/meta/anime/kitsu:${kitsuId}.json`, { timeout: 3000 }).catch(() => null);
      const imdbId = stremRes?.data?.meta?.imdb_id ? `${stremRes.data.meta.imdb_id}:1:${ep}` : null;
      return { imdbId, title, ep };
    }
    
    if (rawId.startsWith('anilist:')) {
      const parts = rawId.split(':');
      const anilistId = parts[1];
      const ep = parts[2] || '1';
      const res = await axios.post('https://graphql.anilist.co', {
        query: `query ($id: Int) { Media(id: $id, type: ANIME) { title { romaji english } idMal } }`,
        variables: { id: parseInt(anilistId) }
      }, { timeout: 3500 });
      const media = res.data?.data?.Media;
      const title = media?.title?.english || media?.title?.romaji;
      return { imdbId: null, title, ep };
    }
  } catch (e) {}
  return null;
}

async function resolveTmdbToImdb(rawId, tmdbKey, type) {
  if (!rawId.startsWith('tmdb:') || !tmdbKey) return null;
  try {
    const parts = rawId.replace('tmdb:', '').split(':');
    const tmdbId = parts[0];
    const s = parts[1];
    const ep = parts[2];
    const endpoint = (type === 'series' || s) 
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${tmdbKey}`
      : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${tmdbKey}`;
    
    const res = await axios.get(endpoint, { timeout: 3500 });
    if (res.data?.imdb_id) {
      return (s && ep) ? `${res.data.imdb_id}:${s}:${ep}` : res.data.imdb_id;
    }
  } catch (e) {}
  return null;
}

// معالج جلب الترجمات الشامل
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
  let tmdbKey = '';
  let subdlKey = '';
  let prefFormat = 'ass';

  if (req.params.config) {
    try {
      const parsedConfig = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8'));
      if (parsedConfig.limit) limit = parsedConfig.limit;
      if (parsedConfig.geminiKey) geminiKey = parsedConfig.geminiKey;
      if (parsedConfig.tmdbKey) tmdbKey = parsedConfig.tmdbKey;
      if (parsedConfig.subdlKey) subdlKey = parsedConfig.subdlKey;
      if (parsedConfig.format) prefFormat = parsedConfig.format;
    } catch (e) {}
  }

  const clientHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Accept': 'application/json'
  };

  const targetIdsToFetch = [targetId];

  // 1. تحويل معرفات الأنمي (Kitsu & AniList)
  if (targetId.startsWith('kitsu:') || targetId.startsWith('anilist:')) {
    const animeData = await resolveAnimeMeta(targetId);
    if (animeData?.imdbId) targetIdsToFetch.push(animeData.imdbId);
  }

  // 2. تحويل معرفات TMDB
  if (targetId.startsWith('tmdb:')) {
    const resolvedImdb = await resolveTmdbToImdb(targetId, tmdbKey, type);
    if (resolvedImdb) targetIdsToFetch.push(resolvedImdb);
  }

  const requests = [];

  for (const fetchId of targetIdsToFetch) {
    const fetchType = (fetchId.startsWith('kitsu') || fetchId.startsWith('anilist') || type === 'anime') ? 'series' : type;

    // OpenSubtitles v3 & OpenSubtitles Community
    requests.push(
      axios.get(`https://opensubtitles-v3.strem.io/subtitles/${fetchType}/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
      axios.get(`https://opensubtitles.strem.fun/subtitles/${fetchType}/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
    );

    // مصادر الأنمي المتخصصة (Anime-Subtitles, Kitsunekko, Subanime)
    if (fetchId.startsWith('kitsu') || fetchId.startsWith('anilist') || fetchId.startsWith('mal') || type === 'anime') {
      requests.push(
        axios.get(`https://anime-subtitles.strem.fun/subtitles/series/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
        axios.get(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
        axios.get(`https://subanime.strem.fun/subtitles/series/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
      );
    }

    // SubDL & Subscene & YTS
    if (subdlKey && fetchId.startsWith('tt')) {
      requests.push(
        axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${subdlKey}&imdb_id=${fetchId}&languages=ar,en`, { timeout: 4000 })
          .then(r => (r.data?.subtitles || []).map(s => ({ id: `subdl_${s.id}`, url: `https://dl.subdl.com${s.url}`, lang: s.language === 'Arabic' ? 'ara' : 'eng' }))).catch(() => [])
      );
    } else {
      requests.push(
        axios.get(`https://subdl-stremio.vercel.app/subtitles/${fetchType}/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
      );
    }

    requests.push(
      axios.get(`https://subscene.strem.fun/subtitles/${fetchType}/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => []),
      axios.get(`https://yifysubtitles.strem.fun/subtitles/${fetchType}/${fetchId}.json`, { headers: clientHeaders, timeout: 4000 }).then(r => r.data?.subtitles || []).catch(() => [])
    );
  }

  try {
    const results = await Promise.all(requests);
    let subtitles = [];
    results.forEach(list => {
      if (Array.isArray(list)) subtitles.push(...list);
    });

    const uniqueSubs = [];
    const seenUrls = new Set();
    for (const sub of subtitles) {
      if (sub && sub.url && !seenUrls.has(sub.url)) {
        seenUrls.add(sub.url);
        uniqueSubs.push(sub);
      }
    }

    // إدراج ترجمة Gemini المباشرة في أول خيار
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
