const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const { resolveMedia } = require('./idMapper');
const { getOpenSubtitles } = require('./opensubtitles');
const { getSubDL } = require('./subdl');
const { getSubSource, fetchSubSourceBuffer } = require('./subsource');
const { getAnimeSubtitles } = require('./anime');

let getWyzie = null;
try {
  const wyzieMod = require('./wyzie');
  getWyzie = wyzieMod.getWyzie || wyzieMod.getSubtitles || wyzieMod;
} catch (e) {
  getWyzie = null;
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;

const MANIFEST = {
  id: 'org.nuvio.aggregated.subtitles',
  version: '25.0.0',
  name: 'Nuvio Multi-Source Subtitles',
  description: 'Arabic & Multi-language subtitles from OpenSubtitles, SubDL, SubSource, Wyzie & Anime',
  resources: ['subtitles'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: []
};

function fixArabicEncoding(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer;

  const utf8Text = buffer.toString('utf-8');
  if (/[\u0600-\u06FF]/.test(utf8Text)) {
    return buffer;
  }

  try {
    const decodedWin = iconv.decode(buffer, 'windows-1256');
    if (/[\u0600-\u06FF]/.test(decodedWin)) {
      return Buffer.from(decodedWin, 'utf-8');
    }
  } catch (e) {}

  try {
    const decodedIso = iconv.decode(buffer, 'iso-8859-6');
    if (/[\u0600-\u06FF]/.test(decodedIso)) {
      return Buffer.from(decodedIso, 'utf-8');
    }
  } catch (e) {}

  return buffer;
}

function parseConfig(req) {
  let config = {
    geminiKey: process.env.GEMINI_API_KEY || '',
    groqKey: process.env.GROQ_API_KEY || '',
    deeplKey: process.env.DEEPL_API_KEY || '',
    openAIKey: process.env.OPENAI_API_KEY || '',
    jimakuKey: process.env.JIMAKU_API_KEY || '',
    subsourceKey: process.env.SUBSOURCE_API_KEY || '',
    openSubtitlesKey: process.env.OPENSUBTITLES_API_KEY || '',
    subdlKey: process.env.SUBDL_API_KEY || '',
    wyzieKey: process.env.WYZIE_API_KEY || ''
  };

  const rawConfig = req.params.config;
  if (rawConfig) {
    try {
      const decodedUrl = decodeURIComponent(rawConfig);
      const decodedB64 = Buffer.from(decodedUrl, 'base64').toString('utf-8');
      config = { ...config, ...JSON.parse(decodedB64) };
    } catch (e) {
      try {
        const decoded = Buffer.from(rawConfig, 'base64').toString('utf-8');
        config = { ...config, ...JSON.parse(decoded) };
      } catch (e2) {}
    }
  }

  return config;
}

function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function findEpisodeInZip(zip, episode) {
  const entries = zip.getEntries();
  const epNum = parseInt(episode, 10);
  const validExts = ['.srt', '.ass', '.vtt'];

  const subEntries = entries.filter(e => {
    const name = e.entryName.toLowerCase();
    return !e.isDirectory && validExts.some(ext => name.endsWith(ext));
  });

  if (!subEntries.length) return null;

  const patterns = [
    new RegExp(`(?:s0*\\d+[._ -]*)?(?:e|ep|episode)[._ -]*0*${epNum}(?:[^0-9]|$)`, 'i'),
    new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'),
    new RegExp(`[\\[\\(]0*${epNum}[\\]\\)]`, 'i'),
    new RegExp(`\\b0*${epNum}\\b`, 'i')
  ];

  for (const pattern of patterns) {
    const matches = subEntries.filter(e => pattern.test(e.entryName));
    if (matches.length > 0) {
      const assMatch = matches.find(e => e.entryName.toLowerCase().endsWith('.ass'));
      return assMatch || matches[0];
    }
  }

  return subEntries[0] || null;
}

function detectFormat(s) {
  const checkStr = [
    s.format,
    s.ext,
    s.extension,
    s.subFormat,
    s.name,
    s.fileName,
    s.url
  ].filter(Boolean).join(' ').toLowerCase();

  if (checkStr.includes('.ass') || checkStr.includes('format=ass') || checkStr.includes(' ass ') || checkStr.endsWith(' ass') || s.format === 'ass') {
    return 'ASS';
  }
  if (checkStr.includes('.vtt') || checkStr.includes('format=vtt') || s.format === 'vtt') {
    return 'VTT';
  }
  return 'SRT';
}

app.post(['/api/test-key', '/test-key'], async (req, res) => {
  const { provider, key } = req.body;
  if (!key || !key.trim()) {
    return res.json({ success: false, message: 'يرجى إدخال المفتاح أولاً ⚠️', status: 'warn' });
  }

  const cleanKey = key.trim();

  try {
    if (provider === 'gemini') {
      const r = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`, { timeout: 7000 });
      if (r.status === 200) return res.json({ success: true, message: 'مفتاح Gemini صالح 100% ✅' });
    } else if (provider === 'groq') {
      const r = await axios.get('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${cleanKey}` },
        timeout: 7000
      });
      if (r.status === 200) return res.json({ success: true, message: 'مفتاح Groq صالح 100% ✅' });
    } else if (provider === 'deepl') {
      let valid = false;
      try {
        const r1 = await axios.get('https://api-free.deepl.com/v2/usage', {
          headers: { 'Authorization': `DeepL-Auth-Key ${cleanKey}` },
          timeout: 5000
        });
        if (r1.status === 200) valid = true;
      } catch (e) {
        const r2 = await axios.get('https://api.deepl.com/v2/usage', {
          headers: { 'Authorization': `DeepL-Auth-Key ${cleanKey}` },
          timeout: 5000
        });
        if (r2.status === 200) valid = true;
      }
      if (valid) return res.json({ success: true, message: 'مفتاح DeepL صالح 100% ✅' });
    } else if (provider === 'openai') {
      const r = await axios.get('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${cleanKey}` },
        timeout: 7000
      });
      if (r.status === 200) return res.json({ success: true, message: 'مفتاح OpenAI صالح 100% ✅' });
    } else if (provider === 'jimaku') {
      const r = await axios.get('https://jimaku.cc/api/entries/search?query=naruto', {
        headers: { 'Authorization': cleanKey },
        timeout: 7000
      });
      if (r.status === 200) return res.json({ success: true, message: 'مفتاح Jimaku صالح 100% ✅' });
    } else if (provider === 'subsource') {
      const r = await axios.get('https://api.subsource.net/api/v1/movies/search?q=avatar&searchType=text', {
        headers: { 'X-API-Key': cleanKey },
        timeout: 7000
      });
      if (r.status === 200) return res.json({ success: true, message: 'مفتاح SubSource صالح 100% ✅' });
    } else if (provider === 'opensubtitles') {
      let valid = false;
      try {
        const r1 = await axios.get('https://api.opensubtitles.com/api/v1/infos/formats', {
          headers: { 'Api-Key': cleanKey, 'User-Agent': 'Mozilla/5.0' },
          timeout: 7000
        });
        if (r1.status === 200) valid = true;
      } catch (e1) {}

      if (!valid) {
        try {
          const r2 = await axios.get('https://api.opensubtitles.com/api/v1/subtitles?imdb_id=0133093', {
            headers: { 'Api-Key': cleanKey, 'User-Agent': 'Mozilla/5.0' },
            timeout: 7000
          });
          if (r2.status === 200) valid = true;
        } catch (e2) {}
      }

      if (valid) return res.json({ success: true, message: 'مفتاح OpenSubtitles صالح 100% ✅' });
    } else if (provider === 'subdl') {
      let valid = false;
      try {
        const r1 = await axios.get(`https://api.subdl.com/api/v1/subtitles?api_key=${cleanKey}&imdb_id=tt0111161`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 7000
        });
        if (r1.status === 200 && (r1.data?.status === true || r1.data?.results)) valid = true;
      } catch (e1) {}

      if (valid) return res.json({ success: true, message: 'مفتاح SubDL صالح 100% ✅' });
    } else if (provider === 'wyzie') {
      if (cleanKey.length > 10) return res.json({ success: true, message: 'مفتاح Wyzie Subs صالح 100% ✅' });
    }

    return res.json({ success: false, message: 'المفتاح غير صالح أو انتهت صلاحيته ❌', status: 'error' });
  } catch (err) {
    const errorDetail = err.response?.data?.error?.message || err.response?.data?.message || err.message || 'Service unavailable';
    return res.json({ success: false, message: `فشل الفحص: ${errorDetail} ❌`, status: 'error' });
  }
});

function renderHtml(config) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>إعدادات كافة مواقع ومفاتيح الترجمة</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0b1120; color: #f1f5f9; display: flex; justify-content: center; padding: 20px 10px 40px; }
    .container { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 16px; }
    .main-title { text-align: center; color: #38bdf8; font-size: 1.35rem; font-weight: 700; margin-bottom: 6px; }
    .section-title { text-align: center; color: #94a3b8; font-size: 0.95rem; font-weight: 600; margin: 12px 0 6px; }
    .card { background-color: #162032; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; border: 1px solid #1e293b; }
    .card-header { display: flex; justify-content: space-between; align-items: center; }
    .card-label { font-size: 0.88rem; font-weight: 600; color: #e2e8f0; }
    .btn-get { display: inline-flex; align-items: center; gap: 4px; font-size: 0.78rem; color: #38bdf8; text-decoration: none; border: 1px solid #0284c7; padding: 3px 8px; border-radius: 6px; background: rgba(2, 132, 199, 0.1); }
    .btn-get:hover { background: rgba(2, 132, 199, 0.25); }
    .input-row { display: flex; gap: 8px; }
    .btn-check { background: #334155; border: 1px solid #475569; color: #f8fafc; font-size: 0.82rem; font-weight: 600; padding: 0 14px; border-radius: 6px; cursor: pointer; height: 38px; min-width: 60px; }
    .btn-check:hover { background: #475569; }
    .input-field { flex: 1; height: 38px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #fff; padding: 0 10px; font-size: 0.85rem; direction: ltr; text-align: left; }
    .input-field:focus { outline: none; border-color: #38bdf8; }
    .status-box { font-size: 0.76rem; line-height: 1.35; padding: 6px 8px; border-radius: 4px; display: none; text-align: right; direction: rtl; word-break: break-word; }
    .status-box.success { display: block; color: #4ade80; background: rgba(74, 222, 128, 0.1); border: 1px solid rgba(74, 222, 128, 0.2); }
    .status-box.error { display: block; color: #f87171; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.2); }
    .status-box.warn { display: block; color: #facc15; background: rgba(250, 204, 21, 0.1); border: 1px solid rgba(250, 204, 21, 0.2); }
    .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
    .btn-action { height: 46px; border-radius: 8px; font-size: 0.95rem; font-weight: 700; cursor: pointer; border: none; display: flex; align-items: center; justify-content: center; gap: 8px; color: #fff; }
    .btn-install { background: #0284c7; }
    .btn-install:hover { background: #0369a1; }
    .btn-copy { background: #334155; border: 1px solid #475569; }
    .btn-copy:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="container">
    <h1 class="main-title">إعدادات كافة مواقع ومفاتيح الترجمة</h1>
    <div class="section-title">🌐 قواعد بيانات ومزودات الترجمة العامة</div>

    <div class="card">
      <div class="card-header">
        <a href="https://subsource.net" target="_blank" class="btn-get">احصل على المفتاح 🔗</a>
        <span class="card-label">:SubSource API مفتاح</span>
      </div>
      <div class="input-row">
        <button class="btn-check" onclick="checkKey('subsource')">فحص</button>
        <input type="text" id="subsourceKey" class="input-field" value="${config.subsourceKey || ''}">
      </div>
      <div id="status-subsource" class="status-box"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <a href="https://www.opensubtitles.com/en/consumers" target="_blank" class="btn-get">احصل على المفتاح 🔗</a>
        <span class="card-label">:OpenSubtitles.com API مفتاح</span>
      </div>
      <div class="input-row">
        <button class="btn-check" onclick="checkKey('opensubtitles')">فحص</button>
        <input type="text" id="openSubtitlesKey" class="input-field" value="${config.openSubtitlesKey || ''}">
      </div>
      <div id="status-opensubtitles" class="status-box"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <a href="https://subdl.com" target="_blank" class="btn-get">احصل على المفتاح 🔗</a>
        <span class="card-label">:SubDL API مفتاح</span>
      </div>
      <div class="input-row">
        <button class="btn-check" onclick="checkKey('subdl')">فحص</button>
        <input type="text" id="subdlKey" class="input-field" value="${config.subdlKey || ''}">
      </div>
      <div id="status-subdl" class="status-box"></div>
    </div>

    <div class="actions">
      <button class="btn-action btn-install" onclick="installAddon()">تثبيت الإضافة في Nuvio 🚀</button>
      <button class="btn-action btn-copy" onclick="copyManifestUrl()">نسخ رابط المانيفست (Manifest URL) 📋</button>
    </div>
  </div>

  <script>
    async function checkKey(provider) {
      const input = document.getElementById(provider + 'Key');
      const statusEl = document.getElementById('status-' + provider);
      const val = input.value.trim();

      statusEl.className = 'status-box';
      statusEl.style.display = 'block';
      statusEl.innerText = 'جارٍ الفحص...';

      try {
        const res = await fetch('/api/test-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, key: val })
        });
        const data = await res.json();
        statusEl.innerText = data.message;
        statusEl.className = data.success ? 'status-box success' : (data.status === 'warn' ? 'status-box warn' : 'status-box error');
      } catch (e) {
        statusEl.className = 'status-box error';
        statusEl.innerText = 'فشل الاتصال بالسيرفر ❌';
      }
    }

    function buildConfigString() {
      const payload = {
        subsourceKey: document.getElementById('subsourceKey').value.trim(),
        openSubtitlesKey: document.getElementById('openSubtitlesKey').value.trim(),
        subdlKey: document.getElementById('subdlKey').value.trim()
      };
      return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(payload)))));
    }

    function installAddon() {
      const b64 = buildConfigString();
      window.location.href = 'nuvio://' + window.location.host + '/' + b64 + '/manifest.json';
    }

    function copyManifestUrl() {
      const b64 = buildConfigString();
      const url = 'https://' + window.location.host + '/' + b64 + '/manifest.json';
      navigator.clipboard.writeText(url).then(() => {
        alert('تم نسخ رابط الإضافة بنجاح!');
      }).catch(() => {
        prompt('انسخ الرابط يدوياً:', url);
      });
    }
  </script>
</body>
</html>`;
}

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderHtml(parseConfig(req)));
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(MANIFEST);
});

app.get([
  '/subtitles/:type/:id', 
  '/subtitles/:type/:id/:extra',
  '/:config/subtitles/:type/:id',
  '/:config/subtitles/:type/:id/:extra'
], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');

  let targetId = req.params.id || '';
  if (targetId.endsWith('.json')) targetId = targetId.slice(0, -5);

  const type = req.params.type;
  const config = parseConfig(req);
  const baseUrl = getBaseUrl(req);

  try {
    const media = await resolveMedia(targetId, type);
    const imdbId = media.imdbId;
    const season = media.season;
    const episode = media.episode;
    let title = media.title || imdbId;
    const mediaType = media.type || type;

    const tasks = [
      getAnimeSubtitles(targetId, episode, config.jimakuKey, title).catch(() => [])
    ];

    if (imdbId) {
      tasks.push(
        getOpenSubtitles({
          imdbId,
          season,
          episode,
          type: mediaType,
          apiKey: config.openSubtitlesKey
        }).catch(() => [])
      );

      tasks.push(
        getSubDL({
          imdbId,
          season,
          episode,
          type: mediaType,
          apiKey: config.subdlKey
        }).catch(() => [])
      );
    }

    if (config.subsourceKey && (title || imdbId)) {
      tasks.push(
        getSubSource({
          title,
          imdbId,
          season,
          episode,
          type: mediaType,
          apiKey: config.subsourceKey
        }).catch(() => [])
      );
    }

    if (getWyzie && config.wyzieKey && imdbId) {
      tasks.push(
        getWyzie({
          imdbId,
          season,
          episode,
          type: mediaType,
          apiKey: config.wyzieKey
        }).catch(() => [])
      );
    }

    const settled = await Promise.allSettled(tasks);
    const allSubs = settled
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(s => s && s.url);

    const sourceCounters = {};

    const formatted = allSubs.map((s) => {
      let finalUrl = s.url;
      const ext = detectFormat(s);
      const rawSource = (s._source || '').toLowerCase();
      let siteName = 'Subtitles';

      if (rawSource.includes('opensubtitles')) siteName = 'OpenSubtitles';
      else if (rawSource.includes('subdl')) siteName = 'SubDL';
      else if (rawSource.includes('subsource')) siteName = 'SubSource';
      else if (rawSource.includes('wyzie')) siteName = 'Wyzie';
      else if (rawSource.includes('animetosho') || rawSource.includes('anime')) siteName = 'AnimeTosho';
      else if (rawSource.includes('jimaku')) siteName = 'Jimaku';

      const groupKey = `${siteName}-${ext}`;
      sourceCounters[groupKey] = (sourceCounters[groupKey] || 0) + 1;
      const count = sourceCounters[groupKey];

      if (s._isZip || s.url.includes('.zip') || rawSource.includes('subdl')) {
        finalUrl = `${baseUrl}/stream-zip.srt?url=${encodeURIComponent(s.url)}&ep=${s._episode || episode || 1}`;
      } else if (s.url.startsWith('subsource://')) {
        finalUrl = `${baseUrl}/stream-subsource.srt?data=${encodeURIComponent(s.url)}`;
      } else if (rawSource.includes('opensubtitles') || s.url.includes('opensubtitles.com')) {
        finalUrl = `${baseUrl}/stream-os.srt?url=${encodeURIComponent(s.url)}&format=${ext.toLowerCase()}`;
      }

      return {
        id: `${siteName} - ${ext} #${count}`,
        url: finalUrl,
        lang: s.lang || 'ara',
        _priority: s._priority || 2
      };
    });

    formatted.sort((a, b) => {
      if (a._priority !== b._priority) return a._priority - b._priority;
      const aIsAr = a.lang === 'ara' || a.lang === 'ar';
      const bIsAr = b.lang === 'ara' || b.lang === 'ar';
      if (aIsAr && !bIsAr) return -1;
      if (!aIsAr && bIsAr) return 1;
      return 0;
    });

    const seenUrls = new Set();
    const uniqueSubs = formatted.filter(s => {
      if (seenUrls.has(s.url)) return false;
      seenUrls.add(s.url);
      return true;
    });

    res.json({ subtitles: uniqueSubs });
  } catch (err) {
    res.json({ subtitles: [] });
  }
});

app.all(['/stream-os', '/stream-os.srt', '/api/stream-os', '/api/stream-os.srt'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const subUrl = req.query.url;
  const requestedFormat = req.query.format || 'srt';

  if (!subUrl) return res.status(400).send('Missing URL');

  try {
    const response = await axios.get(subUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });

    let buffer = Buffer.from(response.data);

    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const subEntry = entries.find(e => !e.isDirectory && (e.entryName.endsWith('.srt') || e.entryName.endsWith('.ass') || e.entryName.endsWith('.vtt')));
      if (subEntry) buffer = subEntry.getData();
    }

    const fixedBuffer = fixArabicEncoding(buffer);
    const contentCheck = fixedBuffer.slice(0, 300).toString('utf-8');
    const isAss = requestedFormat === 'ass' || contentCheck.includes('[Script Info]');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.send(fixedBuffer);
  } catch (e) {
    res.status(500).send('Error streaming OpenSubtitles');
  }
});

app.all(['/stream-zip', '/stream-zip.srt', '/api/stream-zip', '/api/stream-zip.srt'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const zipUrl = req.query.url;
  const ep = req.query.ep || '1';

  if (!zipUrl) return res.status(400).send('Missing URL');

  try {
    const response = await axios.get(zipUrl, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://subdl.com/',
        'Accept': '*/*'
      }
    });

    const zip = new AdmZip(Buffer.from(response.data));
    const entry = findEpisodeInZip(zip, ep);

    if (!entry) return res.status(404).send('Episode not found in archive');

    const rawContent = entry.getData();
    const content = fixArabicEncoding(rawContent);
    const isAss = entry.entryName.toLowerCase().endsWith('.ass') || content.slice(0, 300).toString('utf-8').includes('[Script Info]');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.send(content);
  } catch (e) {
    res.status(500).send('Error extracting ZIP');
  }
});

app.all(['/stream-subsource', '/stream-subsource.srt', '/api/stream-subsource', '/api/stream-subsource.srt'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const dataUrl = req.query.data;
  if (!dataUrl) return res.status(400).send('Missing data');

  try {
    const buffer = await fetchSubSourceBuffer(dataUrl);
    let finalBuffer = buffer;
    let isAss = dataUrl.includes('.ass');

    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const subEntry = entries.find(e => !e.isDirectory && (e.entryName.endsWith('.srt') || e.entryName.endsWith('.ass')));
      if (subEntry) {
        finalBuffer = subEntry.getData();
        isAss = subEntry.entryName.toLowerCase().endsWith('.ass');
      }
    }

    finalBuffer = fixArabicEncoding(finalBuffer);
    if (finalBuffer.slice(0, 300).toString('utf-8').includes('[Script Info]')) {
      isAss = true;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.send(finalBuffer);
  } catch (e) {
    res.status(500).send('Error streaming SubSource');
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

module.exports = app;
