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
    s.origName,
    s.url
  ].filter(Boolean).join(' ').toLowerCase();

  if (s.format === 'ass' || checkStr.includes('.ass') || checkStr.includes('format=ass') || (checkStr.includes('animetosho') && checkStr.includes('.ass'))) {
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
    }

    return res.json({ success: false, message: 'المفتاح غير صالح أو انتهت صلاحيته ❌', status: 'error' });
  } catch (err) {
    return res.json({ success: false, message: 'فشل فحص المفتاح ❌', status: 'error' });
  }
});

app.get(['/', '/configure', '/:config/configure'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>Nuvio Subtitles</title></head><body style="background:#0b1120;color:#fff;text-align:center;padding:50px;"><h2>إضافة Nuvio للترجمة مجهزة وشغالة 🚀</h2></body></html>`);
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

      const isActuallyZip = s._isZip === true || s.url.toLowerCase().endsWith('.zip');
      
      if (isActuallyZip) {
        finalUrl = `${baseUrl}/stream-zip.srt?url=${encodeURIComponent(s.url)}&ep=${s._episode || episode || 1}`;
      } else if (s.url.startsWith('subsource://')) {
        finalUrl = `${baseUrl}/stream-subsource.srt?data=${encodeURIComponent(s.url)}`;
      } else if (rawSource === 'opensubtitles-api' || s.url.includes('api.opensubtitles.com/api/v1/download/')) {
        finalUrl = `${baseUrl}/stream-os.srt?url=${encodeURIComponent(s.url)}&key=${encodeURIComponent(config.openSubtitlesKey || '')}&format=${ext.toLowerCase()}`;
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
  let subUrl = req.query.url;
  const apiKey = req.query.key || '';
  const requestedFormat = req.query.format || 'srt';

  if (!subUrl) return res.status(400).send('Missing URL');

  try {
    if (subUrl.includes('api.opensubtitles.com/api/v1/download/')) {
      const parts = subUrl.split('/');
      const fileId = parseInt(parts[parts.length - 1], 10);

      if (fileId && apiKey) {
        const dlRes = await axios.post(
          'https://api.opensubtitles.com/api/v1/download',
          { file_id: fileId },
          {
            headers: {
              'Api-Key': apiKey,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: 8000
          }
        );
        if (dlRes.data?.link) {
          subUrl = dlRes.data.link;
        }
      }
    }

    const response = await axios.get(subUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://subdl.com/',
        'Accept': '*/*'
      }
    });

    let buffer = Buffer.from(response.data);

    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = new AdmZip(buffer);
      const entry = findEpisodeInZip(zip, ep);
      if (entry) {
        buffer = entry.getData();
      }
    }

    const content = fixArabicEncoding(buffer);
    const isAss = content.slice(0, 300).toString('utf-8').includes('[Script Info]');

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
