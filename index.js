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

const app = express();
app.use(cors());

const PORT = process.env.PORT || 7000;

const MANIFEST = {
  id: 'org.nuvio.aggregated.subtitles',
  version: '1.0.0',
  name: 'Nuvio Multi-Source Subtitles',
  description: 'Arabic & Multi-language subtitles from OpenSubtitles, SubDL, SubSource & Anime',
  resources: ['subtitles'],
  types: ['movie', 'series', 'anime'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: []
};

function ensureUtf8(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer;

  const text = buffer.toString('utf-8');
  if (text.includes('')) {
    try {
      const decoded = iconv.decode(buffer, 'windows-1256');
      return Buffer.from(decoded, 'utf-8');
    } catch (e) {
      return buffer;
    }
  }
  return buffer;
}

function parseConfig(req) {
  let config = {
    openSubtitlesKey: process.env.OPENSUBTITLES_API_KEY || '',
    subdlKey: process.env.SUBDL_API_KEY || '',
    subsourceKey: process.env.SUBSOURCE_API_KEY || ''
  };

  const rawConfig = req.params.config;
  if (rawConfig) {
    try {
      const decoded = Buffer.from(rawConfig, 'base64').toString('utf-8');
      config = { ...config, ...JSON.parse(decoded) };
    } catch (e) {
      try {
        config = { ...config, ...JSON.parse(decodeURIComponent(rawConfig)) };
      } catch (e2) {}
    }
  }

  if (req.query.openSubtitlesKey) config.openSubtitlesKey = req.query.openSubtitlesKey;
  if (req.query.subdlKey) config.subdlKey = req.query.subdlKey;
  if (req.query.subsourceKey) config.subsourceKey = req.query.subsourceKey;

  return config;
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
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

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.json(MANIFEST);
});

app.get(['/subtitles/:type/:id', '/:config/subtitles/:type/:id'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  let targetId = req.params.id || '';
  if (targetId.endsWith('.json')) {
    targetId = targetId.slice(0, -5);
  }

  const type = req.params.type;
  const config = parseConfig(req);
  const baseUrl = getBaseUrl(req);

  try {
    const media = await resolveMedia(targetId, type);
    const imdbId = media.imdbId;
    const season = media.season;
    const episode = media.episode;
    const title = media.title;
    const mediaType = media.type || type;

    const tasks = [
      getAnimeSubtitles(targetId)
    ];

    if (imdbId) {
      tasks.push(getOpenSubtitles({
        imdbId,
        season,
        episode,
        type: mediaType,
        apiKey: config.openSubtitlesKey
      }));

      tasks.push(getSubDL({
        imdbId,
        season,
        episode,
        type: mediaType,
        apiKey: config.subdlKey
      }));
    }

    if (config.subsourceKey && (title || imdbId)) {
      tasks.push(getSubSource({
        title,
        imdbId,
        season,
        episode,
        type: mediaType,
        apiKey: config.subsourceKey
      }));
    }

    const settled = await Promise.allSettled(tasks);
    const allSubs = settled
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(s => s && s.url);

    const formatted = allSubs.map((s, idx) => {
      let finalUrl = s.url;

      if (s._isZip) {
        finalUrl = `${baseUrl}/stream-zip?url=${encodeURIComponent(s.url)}&ep=${s._episode || episode || 1}`;
      } else if (s.url.startsWith('subsource://')) {
        finalUrl = `${baseUrl}/stream-subsource?data=${encodeURIComponent(s.url)}`;
      }

      return {
        id: `${s._source || 'sub'}_${idx}`,
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
    }).map(s => ({
      id: s.id,
      url: s.url,
      lang: s.lang
    }));

    res.json({ subtitles: uniqueSubs });
  } catch (err) {
    res.json({ subtitles: [] });
  }
});

app.get('/stream-zip', async (req, res) => {
  const zipUrl = req.query.url;
  const ep = req.query.ep || '1';

  if (!zipUrl) return res.status(400).send('Missing URL');

  try {
    const response = await axios.get(zipUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const zip = new AdmZip(Buffer.from(response.data));
    const entry = findEpisodeInZip(zip, ep);

    if (!entry) {
      return res.status(404).send('Episode not found in archive');
    }

    const rawContent = entry.getData();
    const content = ensureUtf8(rawContent);
    const isAss = entry.entryName.toLowerCase().endsWith('.ass');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(content);
  } catch (e) {
    res.status(500).send('Error extracting ZIP');
  }
});

app.get('/stream-subsource', async (req, res) => {
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

    finalBuffer = ensureUtf8(finalBuffer);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(finalBuffer);
  } catch (e) {
    res.status(500).send('Error streaming SubSource');
  }
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<h2>Nuvio Subtitles Addon is Running</h2>');
});

app.listen(PORT, () => {});
