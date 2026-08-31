const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

const manifest = {
  id: "org.nuvio.universal.gemini.subtitles",
  version: "26.3.0",
  name: "Universal Subtitles & Gemini AI (Pro)",
  description: "جلب الترجمات الشاملة للأنمي والأفلام مع الترجمة الفورية بالذكاء الاصطناعي",
  resources: [{ name: "subtitles", types: ["movie", "series", "anime", "other"], idPrefixes: ["tt", "kitsu", "mal", "anilist"] }],
  types: ["movie", "series", "anime", "other"],
  idPrefixes: ["tt", "kitsu", "mal", "anilist"],
  catalogs: []
};

// ============= 15. التدوير الذكي لوكلاء المستخدم =============
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/113.0'
];
const getAxiosConfig = (extra = {}) => ({ headers: { 'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)], 'Accept': 'application/json', ...extra }, timeout: 8000 });

// ============= أدوات مساعدة عامة =============
const base64UrlDecode = str => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - str.length % 4) % 4, '='), 'base64').toString('utf8');
const parseImdbId = id => { const p = id.split(':'); return { imdbId: p[0], season: p[1] ? parseInt(p[1]) : null, episode: p[2] ? parseInt(p[2]) : null }; };
const logErr = (lbl, e) => console.error(`[${lbl}] فشل:`, e?.response?.status ? `HTTP ${e.response.status}` : e?.message);
const isAssUrl = url => /\.(ass|ssa)(\?|$)/i.test(url);

// 10 & 13. فك تشفير الإعدادات وإزالة TMDB وإضافة Limit
function decodeConfig(token) {
  const keys = { geminiKey: '', groqKey: '', deeplKey: '', openaiKey: '', jimakuKey: '', subsourceKey: '', openSubKey: '', subdlKey: '', wyzieKey: '', limit: 50 };
  if (!token) return keys;
  try {
    const p = JSON.parse(base64UrlDecode(token));
    Object.keys(keys).forEach(k => { if (p[k] !== undefined) keys[k] = k === 'limit' ? parseInt(p[k]) : p[k]; });
  } catch (e) { logErr('config:decode', e); }
  return keys;
}

const SOURCE_LABELS = { 'opensub-official': 'OpenSubtitles', 'subdl-official': 'SubDL', 'wyzie': 'Wyzie', 'subsource': 'SubSource', 'jimaku': 'Jimaku', 'opensub-v3': 'OpenSub', 'opensub-fun': 'OpenSub', 'subdl-mirror': 'SubDL', 'yify': 'YIFY', 'anime-subs': 'AnimeSubs', 'kitsunekko': 'Kitsunekko', 'subanime': 'SubAnime', 'animetosho': 'AnimeTosho' };
const sourceLabelOf = k => SOURCE_LABELS[k] || 'Source';

// ============= 9. حماية هندسة ASS (Tag Masking) =============
const ASS_DEFAULT_HEADER = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const srtToAssTime = t => { const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/); return m ? `${parseInt(m[1])}:${m[2]}:${m[3]}.${Math.floor(parseInt(m[4])/10).toString().padStart(2,'0')}` : '0:00:00.00'; };
const parseSrt = txt => {
  return txt.replace(/\r/g, '').split(/\n\s*\n+/).map(b => {
    const lines = b.split('\n').filter(l => l.trim());
    if(lines.length < 2) return null;
    const tm = (lines[/^\d+$/.test(lines[0].trim()) ? 1 : 0] || '').match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    return tm ? { start: srtToAssTime(tm[1]), end: srtToAssTime(tm[2]), text: lines.slice(/^\d+$/.test(lines[0].trim()) ? 2 : 1).join('\\N') } : null;
  }).filter(Boolean);
};
const buildAssFromCues = cues => ASS_DEFAULT_HEADER + cues.map(c => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${c.text}`).join('\n') + '\n';

const parseAss = txt => {
  const lines = txt.replace(/\r/g, '').split('\n');
  const evIdx = lines.findIndex(l => l.trim().toLowerCase() === '[events]');
  if(evIdx === -1) return null;
  const fIdx = lines.findIndex((l, i) => i > evIdx && /^Format:/i.test(l.trim()));
  if(fIdx === -1) return null;
  const fieldsLen = lines[fIdx].split(':').slice(1).join(':').split(',').length;
  
  const header = lines.slice(0, fIdx + 1);
  const dialogues = lines.slice(fIdx + 1).map(l => {
    const m = l.match(/^(Dialogue|Comment):\s*/i);
    if(!m) return null;
    const p = l.slice(m[0].length).split(',');
    return { prefix: m[1], before: p.slice(0, fieldsLen - 1), text: p.slice(fieldsLen - 1).join(',') };
  }).filter(Boolean);
  return { headerLines: header, dialogues };
};

const maskTags = txt => { let t = []; return { masked: txt.replace(/\{[^}]+\}/g, m => { t.push(m); return `[T${t.length-1}]`; }), tags: t }; };
const unmaskTags = (txt, t) => { let res = txt; t.forEach((tag, i) => { res = res.replace(new RegExp(`\\[T${i}\\]`, 'g'), tag); }); return res; };

// ============= 8. الترجمة الصارمة ومنع الفشل الصامت =============
async function translateChunkJSON(texts, p, key) {
  const prompt = `Translate to ARABIC strictly. Output raw JSON object: {"data": ["translated_line_1", "translated_line_2"]}. Keep tags like [T0] or \\N unchanged. Length: ${texts.length}. Input: ${JSON.stringify(texts)}`;
  try {
    if (p === 'gemini') {
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: 'application/json' } }, getAxiosConfig({'Content-Type':'application/json'}));
      const raw = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (raw) return (JSON.parse(raw)).data || JSON.parse(raw);
    }
    if (p === 'groq' || p === 'openai') {
      const r = await axios.post(p==='groq'?'https://api.groq.com/openai/v1/chat/completions':'https://api.openai.com/v1/chat/completions', { model: p==='groq'?'llama-3.3-70b-versatile':'gpt-4o-mini', messages: [{role:'user',content:prompt}], response_format: {type:'json_object'} }, getAxiosConfig({Authorization:`Bearer ${key}`,'Content-Type':'application/json'}));
      const raw = r.data?.choices?.[0]?.message?.content;
      if (raw) return (JSON.parse(raw)).data || JSON.parse(raw).translations;
    }
  } catch (e) { logErr(`translate:${p}`, e); }
  return null;
}

async function translateTextArray(texts, keys) {
  if (!texts.length) return null;
  const providers = [{name:'gemini',key:keys.geminiKey},{name:'groq',key:keys.groqKey},{name:'openai',key:keys.openaiKey}].filter(x => x.key);
  if (!providers.length) return null;
  const results = [];
  for (let i = 0; i < texts.length; i += 80) {
    const chunk = texts.slice(i, i + 80);
    let done = null;
    for (const p of providers) { done = await translateChunkJSON(chunk, p.name, p.key); if (done && Array.isArray(done) && done.length === chunk.length) break; done = null; }
    if (!done) return null;
    results.push(...done);
  }
  return results;
}

// ============= 3 & 4 & 6. التخزين المؤقت، الجسر المزدوج، وأفلام الأنمي =============
let animeListCache = null, animeListCacheTime = 0;
const idResolveCache = new Map();

async function getAnimeListMap() {
  if (animeListCache && Date.now() - animeListCacheTime < 86400000) return animeListCache;
  try {
    const r = await axios.get('https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json', getAxiosConfig());
    if (Array.isArray(r.data)) { animeListCache = r.data; animeListCacheTime = Date.now(); }
  } catch (e) { logErr('animeMap', e); }
  return animeListCache || [];
}

async function resolveExternalId(rawId) {
  if (idResolveCache.has(rawId)) return idResolveCache.get(rawId);
  try {
    const parts = rawId.split(':'), prefix = parts[0];
    const map = await getAnimeListMap();
    let res = { imdbId: null, kitsuId: null, absoluteEp: null, title: null, isMovie: false };

    if (['kitsu','mal','anilist'].includes(prefix)) {
      const extId = parts[1]; res.absoluteEp = parts[2] ? parseInt(parts[2]) : null;
      if (!res.absoluteEp) res.isMovie = true;
      const f = prefix==='kitsu'?'kitsu_id':prefix==='mal'?'mal_id':'anilist_id';
      const entry = map.find(e => String(e[f]) === String(extId));
      res.kitsuId = entry?.kitsu_id || (prefix==='kitsu'?extId:null);
      
      if (prefix==='kitsu') {
        const kRes = await axios.get(`https://kitsu.io/api/edge/anime/${extId}`, getAxiosConfig()).catch(()=>null);
        res.title = kRes?.data?.data?.attributes?.canonicalTitle || null;
      }
      if (entry?.imdb_id) {
        const iId = Array.isArray(entry.imdb_id) ? entry.imdb_id[0] : String(entry.imdb_id).split(',')[0].trim();
        res.imdbId = res.isMovie ? iId : `${iId}:${entry.season?.tvdb ?? 1}:${res.absoluteEp + (entry.episode_offset?.tvdb ?? 0)}`;
      }
    } else if (prefix === 'tt') {
      const season = parts[1] ? parseInt(parts[1]) : null, episode = parts[2] ? parseInt(parts[2]) : null;
      if (!season && !episode) res.isMovie = true;
      const entry = map.find(e => (Array.isArray(e.imdb_id) ? e.imdb_id : String(e.imdb_id).split(',')).includes(parts[0]) && (season == null || (e.season?.tvdb ?? 1) === season));
      if (entry) { res.kitsuId = entry.kitsu_id; if (episode != null) res.absoluteEp = episode - (entry.episode_offset?.tvdb ?? 0); }
      res.imdbId = rawId;
    }
    idResolveCache.set(rawId, res); return res;
  } catch (e) { logErr('resolveId', e); return null; }
}

// ============= استرجاع دوال API المباشرة (Direct Fetch) =============
async function fetchOpenSubtitlesDirect(imdbId, season, episode, apiKey, seasonPack=false) {
  if (!apiKey) return [];
  try {
    const p = new URLSearchParams({ imdb_id: imdbId.replace('tt', ''), languages: 'ar,en' });
    if (season) p.set('season_number', season); if (episode) p.set('episode_number', episode);
    const r = await axios.get(`https://api.opensubtitles.com/api/v1/subtitles?${p.toString()}`, getAxiosConfig({'Api-Key': apiKey.trim()}));
    const out = [];
    for (const i of (r.data?.data || [])) {
      const fId = i.attributes?.files?.[0]?.file_id; if (!fId) continue;
      try {
        const dl = await axios.post('https://api.opensubtitles.com/api/v1/download', {file_id: fId}, getAxiosConfig({'Api-Key': apiKey.trim(), 'Content-Type': 'application/json'}));
        if (dl.data?.link) out.push({ url: dl.data.link, lang: i.attributes.language || 'en', origName: i.attributes.release || i.attributes.files?.[0]?.file_name, _source: 'opensub-official', _seasonPack: seasonPack });
      } catch (e) { }
    }
    return out;
  } catch (e) { logErr('opensubDirect', e); return []; }
}

async function fetchSubDLDirect(imdbId, season, episode, apiKey, seasonPack=false) {
  if (!apiKey) return [];
  try {
    const p = new URLSearchParams({ api_key: apiKey.trim(), imdb_id: imdbId, languages: 'AR,EN' });
    if (season) p.set('season_number', season); if (episode) p.set('episode_number', episode);
    const r = await axios.get(`https://api.subdl.com/api/v1/subtitles?${p.toString()}`, getAxiosConfig());
    return (r.data?.subtitles || []).filter(i => i.url).map(i => ({ zipUrl: i.url.startsWith('http') ? i.url : `https://dl.subdl.com${i.url}`, lang: (i.lang || 'en').toLowerCase(), origName: i.release_name || i.name, _source: 'subdl-official', _seasonPack: seasonPack || !!i.full_season }));
  } catch (e) { logErr('subdlDirect', e); return []; }
}

async function fetchWyzieDirect(imdbId, season, episode, apiKey, seasonPack=false) {
  if (!apiKey) return [];
  try {
    const p = new URLSearchParams({ id: imdbId, key: apiKey.trim(), language: 'ar,en' });
    if (season) p.set('season', season); if (episode) p.set('episode', episode);
    const r = await axios.get(`https://sub.wyzie.io/search?${p.toString()}`, getAxiosConfig());
    return (Array.isArray(r.data) ? r.data : []).filter(i => i.url).map(i => ({ url: i.url, lang: (i.language || 'en').toLowerCase(), origName: i.release || i.fileName, _source: 'wyzie', _seasonPack: seasonPack }));
  } catch (e) { logErr('wyzieDirect', e); return []; }
}

const mirrorReq = (url, src, sp) => axios.get(url, getAxiosConfig()).then(r => (r.data?.subtitles || []).map(s => ({ url: s.url, lang: s.lang, origName: s.title || s.SubFileName || s.release || s.name, _source: src, _seasonPack: !!sp }))).catch(() => []);
const buildMirrorReqs = (tid, type, sp = false) => {
  const reqs = [ mirrorReq(`https://opensubtitles-v3.strem.io/subtitles/${type}/${tid}.json`, 'opensub-v3', sp), mirrorReq(`https://opensubtitles.strem.fun/subtitles/${type}/${tid}.json`, 'opensub-fun', sp), mirrorReq(`https://subdl-stremio.vercel.app/subtitles/${type}/${tid}.json`, 'subdl-mirror', sp), mirrorReq(`https://yifysubtitles.strem.fun/subtitles/${type}/${tid}.json`, 'yify', sp) ];
  if (tid.startsWith('kitsu') || tid.startsWith('anilist') || tid.startsWith('mal') || type === 'series') {
    reqs.push(mirrorReq(`https://anime-subtitles.strem.fun/subtitles/series/${tid}.json`, 'anime-subs', sp), mirrorReq(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${tid}.json`, 'kitsunekko', sp));
  }
  return reqs;
};

// ============= واجهة الإعدادات =============
app.get(['/', '/configure'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Nuvio Subtitles Pro</title><style>body{font-family:system-ui;background:#0b0f19;color:#f8fafc;display:flex;justify-content:center;padding:20px;} .card{background:#1e293b;padding:25px;border-radius:16px;width:100%;max-width:530px;border:1px solid #334155;} h2{color:#38bdf8;text-align:center;} label{font-size:13px;color:#cbd5e1;} input,select{width:100%;padding:10px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#fff;margin-bottom:12px;} .btn{width:100%;padding:14px;border-radius:8px;border:none;background:#0284c7;color:#fff;font-weight:bold;cursor:pointer;margin-top:10px;}</style></head><body><div class="card"><h2>إعدادات الإضافة الشاملة</h2><label>مفتاح Gemini API (للترجمة):</label><input type="text" id="geminiKey"><label>مفتاح Groq API:</label><input type="text" id="groqKey"><label>مفتاح OpenSubtitles API:</label><input type="text" id="openSubKey"><label>مفتاح SubDL API:</label><input type="text" id="subdlKey"><label>مفتاح Wyzie API:</label><input type="text" id="wyzieKey"><label>سقف النتائج (مع استثناء 5 AI):</label><select id="limit"><option value="10">10 نتائج</option><option value="25">25 نتيجة</option><option value="50" selected>50 نتيجة</option><option value="100">100 نتيجة</option></select><button class="btn" onclick="install()">تثبيت في Nuvio</button></div><script>function install(){ const cfg = btoa(JSON.stringify({ geminiKey:document.getElementById('geminiKey').value.trim(), groqKey:document.getElementById('groqKey').value.trim(), openSubKey:document.getElementById('openSubKey').value.trim(), subdlKey:document.getElementById('subdlKey').value.trim(), wyzieKey:document.getElementById('wyzieKey').value.trim(), limit:document.getElementById('limit').value })).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); window.location.href = 'nuvio://' + (window.location.origin + '/' + cfg + '/manifest.json').replace(/^https?:\\/\\//, '');}</script></body></html>`);
});

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => res.json(manifest));

// ============= الترجمة الفورية (14. إصلاح الترميز & 8. الفشل الصامت) =============
app.get(['/translate', '/:config/translate', '/translate/trans.ass', '/:config/translate/trans.ass'], async (req, res) => {
  const subUrl = req.query.subUrl; if (!subUrl) return res.status(400).send("No URL");
  const keys = req.params.config ? decodeConfig(req.params.config) : req.query;
  let text;
  try {
    const r = await axios.get(subUrl, { responseType: 'arraybuffer', timeout: 12000, headers: {'User-Agent': USER_AGENTS[0]} });
    const buf = Buffer.from(r.data); text = buf.toString('utf8');
    if (text.includes('')) text = iconv.decode(buf, 'win1256');
  } catch (err) { return res.redirect(subUrl); }

  const isAss = isAssUrl(subUrl) || /^\uFEFF?\[Script Info\]/im.test(text);
  let outText = text;
  try {
    const assP = isAss ? parseAss(text) : null;
    const cues = assP ? assP.dialogues : (parseSrt(text) || []);
    if (cues.length > 0) {
      const masked = cues.map(c => { const m = maskTags(c.text); return { txt: c.text, masked: m.masked, tags: m.tags }; });
      const trans = await translateTextArray(masked.map(c => c.masked), keys);
      
      if (trans && trans.length === cues.length) {
        if (assP) {
          const lines = [...assP.headerLines];
          assP.dialogues.forEach((d, i) => lines.push(`${d.prefix}: ${d.before.join(',')},${unmaskTags(trans[i], masked[i].tags)}`));
          outText = lines.join('\n') + '\n';
        } else {
          outText = buildAssFromCues(cues.map((c, i) => ({ start: c.start, end: c.end, text: unmaskTags(trans[i], masked[i].tags) })));
        }
      } else {
        const errMsg = "[النظام] فشلت الترجمة الفورية، يرجى المحاولة لاحقاً.";
        outText = (assP ? assP.headerLines.join('\n') : ASS_DEFAULT_HEADER) + `\nDialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${errMsg}\n`;
      }
    }
  } catch (e) { logErr('translate', e); }
  res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8'); res.send(outText);
});

// ============= جلب الترجمات الشاملة (2. و 7. إلغاء الفحص الصارم) =============
app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json', '/:config/subtitles/:type/:id.json', '/:config/subtitles/:type/:id/:extra.json'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { type, id, extra } = req.params;
  const targetId = extra && extra.endsWith('.json') ? `${id}/${extra.replace('.json', '')}` : id.replace('.json', '');
  const config = decodeConfig(req.params.config);
  const animeInfo = await resolveExternalId(targetId);
  const tIds = [targetId];
  if (animeInfo?.imdbId && !tIds.includes(animeInfo.imdbId)) tIds.push(animeInfo.imdbId);
  if (animeInfo?.kitsuId && animeInfo?.absoluteEp && !tIds.includes(`kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`)) tIds.push(`kitsu:${animeInfo.kitsuId}:${animeInfo.absoluteEp}`);

  const reqs = [];
  for (const tid of tIds) {
    const fType = (tid.startsWith('kitsu') || type === 'anime') ? 'series' : type;
    reqs.push(...buildMirrorReqs(tid, fType, false));
    if (tid.startsWith('tt')) {
      const { imdbId, season, episode } = parseImdbId(tid);
      if (config.openSubKey) reqs.push(fetchOpenSubtitlesDirect(imdbId, season, episode, config.openSubKey));
      if (config.wyzieKey) reqs.push(fetchWyzieDirect(imdbId, season, episode, config.wyzieKey));
    }
  }

  const spIds = [...new Set(tIds.filter(t=>t.startsWith('tt')).map(t=>{const p=parseImdbId(t); return p.season?`${p.imdbId}:${p.season}`:null;}).filter(Boolean))];
  for (const spid of spIds) {
    reqs.push(...buildMirrorReqs(spid, 'series', true));
    const { imdbId, season } = parseImdbId(spid);
    if (config.openSubKey) reqs.push(fetchOpenSubtitlesDirect(imdbId, season, null, config.openSubKey, true));
    if (config.wyzieKey) reqs.push(fetchWyzieDirect(imdbId, season, null, config.wyzieKey, true));
  }

  if (animeInfo?.title) {
    reqs.push(axios.get(`https://animetosho.org/api/v1/search?q=${encodeURIComponent(`${animeInfo.title} ${animeInfo.absoluteEp||''}`.trim())}`, getAxiosConfig()).then(r => (r.data?.results||[]).filter(i=>i.attachment_url).map(i=>({ url: i.attachment_url, lang: 'eng', origName: i.title, _source: 'animetosho' }))).catch(()=>[]));
  }

  let subdlZips = [];
  if (config.subdlKey) {
    for (const tid of tIds.filter(t=>t.startsWith('tt'))) { const p = parseImdbId(tid); subdlZips.push(...await fetchSubDLDirect(p.imdbId, p.season, p.episode, config.subdlKey)); }
    for (const spid of spIds) { const p = parseImdbId(spid); subdlZips.push(...await fetchSubDLDirect(p.imdbId, p.season, null, config.subdlKey, true)); }
  }

  const results = await Promise.all(reqs);
  let rawSubs = results.flat();
  const host = req.get('host'), protocol = req.protocol;
  
  subdlZips.forEach(z => rawSubs.push({ ...z, url: `${protocol}://${host}/subdl-extract?zipUrl=${encodeURIComponent(z.zipUrl)}` }));

  const uMap = new Map();
  for (const s of rawSubs) {
    if (!s || !s.url) continue;
    s._ext = (s.url.match(/\.(srt|ass|ssa|vtt)(\?|$)/i) || [, 'srt'])[1].toLowerCase();
    const k = s.url.split('?')[0] + (s.origName||'');
    if (!uMap.has(k)) uMap.set(k, s);
  }
  rawSubs = Array.from(uMap.values());

  const arSubs = [], enSubs = [];
  for (const s of rawSubs) {
    const l = (s.lang||'').toLowerCase(), isAr = l==='ara'||l==='ar'||l.includes('ara');
    const orig = s.origName || (isAr ? 'ترجمة عربية' : 'Subtitle');
    const tag = s._seasonPack ? ' [باقة الموسم]' : '';
    const name = `${orig} \u200F•\u200E ${sourceLabelOf(s._source)} \u200F•\u200E ${s._ext.toUpperCase()}${tag}`;
    const formatted = { id: `sub_${s.url.slice(-10)}`, url: s.url, lang: isAr ? 'ara' : (l||'eng'), name, title: name, _ext: s._ext, _source: s._source, origName: orig };
    isAr ? arSubs.push(formatted) : enSubs.push(formatted);
  }

  const rank = { ass: 0, ssa: 0, vtt: 1, srt: 2 };
  const sorter = (a, b) => (rank[a._ext]??3) - (rank[b._ext]??3);
  arSubs.sort(sorter); enSubs.sort(sorter);

  // 13. القطع بناء على الحد المختار
  const limitedAr = arSubs.slice(0, config.limit);

  // 1 & 11 & 12. تراجم الذكاء الاصطناعي الثابتة بـ 5
  const aiSubs = [];
  if (enSubs.length > 0 && (config.geminiKey || config.groqKey || config.openaiKey)) {
    const base = req.params.config ? `${protocol}://${host}/${req.params.config}` : `${protocol}://${host}`;
    enSubs.slice(0, 5).forEach((c, idx) => {
      const aiName = `${c.origName} \u200F•\u200E ${sourceLabelOf(c._source)} \u200F•\u200E trans \u200F•\u200E ASS`;
      aiSubs.push({ id: `trans_${idx+1}`, url: `${base}/translate/trans.ass?subUrl=${encodeURIComponent(c.url)}`, lang: 'ara', name: aiName, title: aiName });
    });
  }

  res.json({ subtitles: [...limitedAr.map(({_ext,_source,origName,...rest})=>rest), ...aiSubs] });
});

app.get('/subdl-extract', async (req, res) => {
  try {
    const r = await axios.get(req.query.zipUrl, { responseType: 'arraybuffer', timeout: 12000, headers: {'User-Agent': USER_AGENTS[0]} });
    const z = new AdmZip(Buffer.from(r.data)), entries = z.getEntries().filter(e => /\.(srt|ass|ssa|vtt)$/i.test(e.entryName));
    if (!entries.length) return res.status(404).send("No sub found");
    const chosen = entries.find(e=>/\.ass$/i.test(e.entryName)) || entries.find(e=>/\.srt$/i.test(e.entryName)) || entries[0];
    res.setHeader('Content-Type', chosen.entryName.toLowerCase().endsWith('ass') ? 'text/x-ssa; charset=utf-8' : 'text/plain; charset=utf-8');
    res.send(chosen.getData().toString('utf8'));
  } catch (err) { logErr('extract', err); res.status(500).send("Extraction failed"); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
