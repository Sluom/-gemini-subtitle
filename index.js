const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const zlib = require('zlib');
const { resolveMedia } = require('./idMapper');
const { getOpenSubtitles } = require('./opensubtitles');
const { getSubDL } = require('./subdl');
const { getSubSource, fetchSubSourceBuffer } = require('./subsource');
const { getAnimeSubtitles } = require('./anime');
const { handleTranslationSrt, handleTranslationAss } = require('./ai');

let getWyzie = null;
try { getWyzie = require('./wyzie').getWyzie || require('./wyzie').getSubtitles || require('./wyzie'); } catch (e) { getWyzie = null; }

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 7000;
const MANIFEST = {
  id: 'org.nuvio.aggregated.subtitles', version: '25.0.0', name: 'Nuvio Multi-Source Subtitles',
  description: 'Arabic & Multi-language subtitles from OpenSubtitles, SubDL, SubSource, Wyzie & Anime',
  resources: ['subtitles'], types: ['movie', 'series', 'anime'], idPrefixes: ['tt', 'kitsu'], catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false }
};

const ASS_DEFAULT_HEADER = `[Script Info]\nScriptType: v4.00+\nCollisions: Normal\nPlayDepth: 0\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,26,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

// ذاكرة الترجمة الخلفية
const translationStatusCache = new Map();

function handleAiResponse(req, res, fixedBuffer, isAss) {
  const doTranslate = req.query.translate === 'true';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', isAss ? 'text/x-ssa; charset=utf-8' : 'application/x-subrip; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="subtitle.${isAss ? 'ssa' : 'srt'}"`);

  if (!doTranslate) return res.send(fixedBuffer);

  const cacheKey = req.originalUrl;
  if (translationStatusCache.has(cacheKey)) {
    const state = translationStatusCache.get(cacheKey);
    if (state.status === 'done') return res.send(state.text);
    if (state.status === 'processing') return res.send(isAss ? ASS_DEFAULT_HEADER + "Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[النظام] الترجمة قيد التجهيز.. أعد التشغيل بعد قليل.\n" : "1\n00:00:01,000 --> 00:00:08,000\n[النظام] الترجمة قيد التجهيز.. أعد التشغيل بعد قليل.\n");
    if (state.status === 'error') return res.send(isAss ? ASS_DEFAULT_HEADER + "Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[النظام] حدث خطأ أثناء الترجمة.\n" : "1\n00:00:01,000 --> 00:00:08,000\n[النظام] حدث خطأ أثناء الترجمة.\n");
  }

  translationStatusCache.set(cacheKey, { status: 'processing' });
  const rawText = fixedBuffer.toString('utf-8');

  (async () => {
    try {
        let translatedText = isAss ? ASS_DEFAULT_HEADER + await handleTranslationAss(rawText) : await handleTranslationSrt(rawText);
        translationStatusCache.set(cacheKey, { status: 'done', text: translatedText });
    } catch (err) {
        translationStatusCache.set(cacheKey, { status: 'error' });
    }
  })();

  return res.send(isAss ? ASS_DEFAULT_HEADER + "Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[النظام] تم بدء الترجمة.. يرجى العودة بعد دقيقة.\n" : "1\n00:00:01,000 --> 00:00:08,000\n[النظام] تم بدء الترجمة.. يرجى العودة بعد دقيقة.\n");
}

function fixArabicEncoding(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return buffer;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) { try { return Buffer.from(iconv.decode(buffer, 'utf16-le'), 'utf-8'); } catch(e) {} }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) { try { return Buffer.from(iconv.decode(buffer, 'utf16-be'), 'utf-8'); } catch(e) {} }
  const utf8Text = buffer.toString('utf-8');
  if (/[\u0600-\u06FF]/.test(utf8Text)) return buffer;
  try { const decodedWin = iconv.decode(buffer, 'windows-1256'); if (/[\u0600-\u06FF]/.test(decodedWin)) return Buffer.from(decodedWin, 'utf-8'); } catch (e) {}
  try { const decodedIso = iconv.decode(buffer, 'iso-8859-6'); if (/[\u0600-\u06FF]/.test(decodedIso)) return Buffer.from(decodedIso, 'utf-8'); } catch (e) {}
  return buffer;
}

function parseConfig(req) {
  let config = { geminiKey: process.env.GEMINI_API_KEY || '', groqKey: process.env.GROQ_API_KEY || '', deeplKey: process.env.DEEPL_API_KEY || '', openAIKey: process.env.OPENAI_API_KEY || '', jimakuKey: process.env.JIMAKU_API_KEY || '', subsourceKey: process.env.SUBSOURCE_API_KEY || '', openSubtitlesKey: process.env.OPENSUBTITLES_API_KEY || '', subdlKey: process.env.SUBDL_API_KEY || '', wyzieKey: process.env.WYZIE_API_KEY || '' };
  const rawConfig = req.params.config;
  if (rawConfig) {
    try { const decodedUrl = decodeURIComponent(rawConfig); config = { ...config, ...JSON.parse(Buffer.from(decodedUrl, 'base64').toString('utf-8')) }; } catch (e) {
      try { config = { ...config, ...JSON.parse(Buffer.from(rawConfig, 'base64').toString('utf-8')) }; } catch (e2) {}
    }
  }
  return config;
}

function getBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;
}

function findEpisodeInZip(zip, episode) {
  const entries = zip.getEntries();
  const epNum = parseInt(episode, 10);
  const validExts = ['.srt', '.ass', '.ssa', '.vtt'];
  const subEntries = entries.filter(e => !e.isDirectory && validExts.some(ext => e.entryName.toLowerCase().endsWith(ext)));
  if (!subEntries.length) return null;
  const patterns = [ new RegExp(`(?:s0*\\d+[._ -]*)?(?:e|ep|episode)[._ -]*0*${epNum}(?:[^0-9]|$)`, 'i'), new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'), new RegExp(`[\\[\\(]0*${epNum}[\\]\\)]`, 'i'), new RegExp(`\\b0*${epNum}\\b`, 'i') ];
  for (const pattern of patterns) {
    const matches = subEntries.filter(e => pattern.test(e.entryName));
    if (matches.length > 0) return matches.find(e => e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa')) || matches[0];
  }
  return subEntries.find(e => e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa')) || subEntries[0] || null;
}

function detectFormat(s) {
  const formatVal = (s.format || '').toLowerCase(); const subFormatVal = (s.subFormat || s.SubFormat || '').toLowerCase(); const extVal = (s.ext || s.extension || '').toLowerCase(); const rawName = (s.fileName || s.origName || s.name || '').toLowerCase(); const rawUrl = (s.url || '').toLowerCase();
  if (formatVal === 'ssa' || subFormatVal === 'ssa' || extVal === 'ssa' || rawUrl.includes('.ssa') || rawUrl.includes('format=ssa') || rawName.endsWith('.ssa') || rawName.includes('.ssa') || rawName.includes('[ssa]') || formatVal === 'ass' || subFormatVal === 'ass' || extVal === 'ass' || rawUrl.includes('.ass') || rawUrl.includes('format=ass') || rawName.endsWith('.ass') || rawName.includes('.ass') || rawName.includes('[ass]')) return 'ssa';
  if (formatVal === 'vtt' || subFormatVal === 'vtt' || extVal === 'vtt' || rawUrl.includes('.vtt') || rawUrl.includes('format=vtt') || rawName.endsWith('.vtt')) return 'vtt';
  return 'srt';
}

app.post('/api/test-key', async (req, res) => { return res.json({ success: true, message: 'تم التخطي' }); });

function renderHtml(config) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>إعداداتافة مواقع ومفاتيح الترجمة</title><style>*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}body{background-color:#0b1120;color:#f1f5f9;display:flex;justify-content:center;padding:20px 10px 40px;}.container{width:100%;max-width:480px;display:flex;flex-direction:column;gap:14px;}.main-title{text-align:center;color:#38bdf8;font-size:1.35rem;font-weight:700;margin-bottom:4px;}.section-title{text-align:center;color:#94a3b8;font-size:0.95rem;font-weight:600;margin:12px 0 4px;}.card{background-color:#162032;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;border:1px solid #1e293b;}.card-header{display:flex;justify-content:space-between;align-items:center;}.card-label{font-size:0.88rem;font-weight:600;color:#e2e8f0;}.btn-get{display:inline-flex;align-items:center;gap:4px;font-size:0.78rem;color:#38bdf8;text-decoration:none;border:1px solid #0284c7;padding:3px 8px;border-radius:6px;background:rgba(2,132,199,0.1);}.btn-get:hover{background:rgba(2,132,199,0.25);}.input-row{display:flex;gap:8px;}.btn-check{background:#334155;border:1px solid #475569;color:#f8fafc;font-size:0.82rem;font-weight:600;padding:0 14px;border-radius:6px;cursor:pointer;height:38px;min-width:60px;}.btn-check:hover{background:#475569;}.input-field{flex:1;height:38px;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#fff;padding:0 10px;font-size:0.85rem;direction:ltr;text-align:left;}.input-field:focus{outline:none;border-color:#38bdf8;}.status-box{font-size:0.76rem;line-height:1.35;padding:6px 8px;border-radius:4px;display:none;text-align:right;direction:rtl;word-break:break-word;}.status-box.success{display:block;color:#4ade80;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.2);}.status-box.error{display:block;color:#f87171;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2);}.status-box.warn{display:block;color:#facc15;background:rgba(250,204,21,0.1);border:1px solid rgba(250,204,21,0.2);}.actions{display:flex;flex-direction:column;gap:10px;margin-top:15px;}.btn-action{height:46px;border-radius:8px;font-size:0.95rem;font-weight:700;cursor:pointer;border:none;display:flex;align-items:center;justify-content:center;gap:8px;color:#fff;text-decoration:none;}.btn-install{background:#0284c7;}.btn-install:hover{background:#0369a1;}.btn-copy{background:#334155;border:1px solid #475569;}.btn-copy:hover{background:#475569;}</style></head><body><div class="container"><h1 class="main-title">إعدادات كافة مواقع ومفاتيح الترجمة</h1><h2 class="section-title">🤖 محركات الذكاء الاصطناعي (الترجمة الفورية)</h2><div class="card"><div class="card-header"><span class="card-label">مفتاح Google Gemini API:</span><a href="https://aistudio.google.com/app/apikey" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="geminiKey" class="input-field" placeholder="Google Gemini API Key" value="${config.geminiKey || ''}"><button class="btn-check" onclick="checkKey('gemini')">فحص</button></div><div id="status-gemini" class="status-box"></div></div><div class="card"><div class="card-header"><span class="card-label">مفتاح Groq API (فائق السرعة):</span><a href="https://console.groq.com/keys" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="groqKey" class="input-field" placeholder="Groq API Key" value="${config.groqKey || ''}"><button class="btn-check" onclick="checkKey('groq')">فحص</button></div><div id="status-groq" class="status-box"></div></div><div class="card"><div class="card-header"><span class="card-label">مفتاح DeepL API:</span><a href="https://www.deepl.com/your-account/keys" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="deeplKey" class="input-field" placeholder="DeepL API Key" value="${config.deeplKey || ''}"><button class="btn-check" onclick="checkKey('deepl')">فحص</button></div><div id="status-deepl" class="status-box"></div></div><div class="card"><div class="card-header"><span class="card-label">مفتاح OpenAI API:</span><a href="https://platform.openai.com/api-keys" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="openAIKey" class="input-field" placeholder="OpenAI API Key" value="${config.openAIKey || ''}"><button class="btn-check" onclick="checkKey('openai')">فحص</button></div><div id="status-openai" class="status-box"></div></div><h2 class="section-title">🎌 مواقع ومصادر ترجمات الأنمي التخصصية</h2><div class="card"><div class="card-header"><span class="card-label">مفتاح Jimaku.cc API (اختياري للأنمي):</span><a href="https://jimaku.cc/" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="jimakuKey" class="input-field" placeholder="Jimaku API Token" value="${config.jimakuKey || ''}"><button class="btn-check" onclick="checkKey('jimaku')">فحص</button></div><div id="status-jimaku" class="status-box"></div></div><h2 class="section-title">🌐 قواعد بيانات ومزودات الترجمة العامة</h2><div class="card"><div class="card-header"><span class="card-label">مفتاح SubSource API:</span><a href="https://subsource.net/" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="subsourceKey" class="input-field" placeholder="SubSource API Key" value="${config.subsourceKey || ''}"><button class="btn-check" onclick="checkKey('subsource')">فحص</button></div><div id="status-subsource" class="status-box"></div></div><div class="card"><div class="card-header"><span class="card-label">مفتاح OpenSubtitles.com API:</span><a href="https://www.opensubtitles.com/en/consumers" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="openSubtitlesKey" class="input-field" placeholder="OpenSubtitles API Key" value="${config.openSubtitlesKey || ''}"><button class="btn-check" onclick="checkKey('opensubtitles')">فحص</button></div><div id="status-opensubtitles" class="status-box"></div></div><div class="card"><div class="card-header"><span class="card-label">مفتاح SubDL API:</span><a href="https://subdl.com/panel/api" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="subdlKey" class="input-field" placeholder="SubDL API Key" value="${config.subdlKey || ''}"><button class="btn-check" onclick="checkKey('subdl')">فحص</button></div><div id="status-subdl" class="status-box"></div></div><div class="card"><div class="card-header"><span class="card-label">مفتاح Wyzie Subs API:</span><a href="https://store.wyzie.io/" target="_blank" class="btn-get">احصل على المفتاح 🔗</a></div><div class="input-row"><input type="text" id="wyzieKey" class="input-field" placeholder="Wyzie Subs API Key" value="${config.wyzieKey || ''}"><button class="btn-check" onclick="checkKey('wyzie')">فحص</button></div><div id="status-wyzie" class="status-box"></div></div><div class="actions"><button class="btn-action btn-install" onclick="installAddon()">تثبيت الإضافة في Nuvio و Stremio 🚀</button><button id="copyBtn" class="btn-action btn-copy" style="display: none;" onclick="copyManifestUrl()">نسخ رابط المانيفست (Manifest URL) 📋</button></div></div><script>async function checkKey(p){const i=document.getElementById(p==='gemini'?'geminiKey':p==='groq'?'groqKey':p==='deepl'?'deeplKey':p==='openai'?'openAIKey':p==='jimaku'?'jimakuKey':p==='subsource'?'subsourceKey':p==='opensubtitles'?'openSubtitlesKey':p==='subdl'?'subdlKey':'wyzieKey');const s=document.getElementById('status-'+p);s.className='status-box';s.style.display='block';s.innerText='جارٍ الفحص...';try{const r=await fetch('/api/test-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:p,key:i.value.trim()})});const d=await r.json();s.innerText=d.message;s.className=d.success?'status-box success':d.status==='warn'?'status-box warn':'status-box error';}catch(e){s.className='status-box error';s.innerText='فشل الاتصال بالسيرفر ❌';}}function buildConfigString(){const p={geminiKey:document.getElementById('geminiKey').value.trim(),groqKey:document.getElementById('groqKey').value.trim(),deeplKey:document.getElementById('deeplKey').value.trim(),openAIKey:document.getElementById('openAIKey').value.trim(),jimakuKey:document.getElementById('jimakuKey').value.trim(),subsourceKey:document.getElementById('subsourceKey').value.trim(),openSubtitlesKey:document.getElementById('openSubtitlesKey').value.trim(),subdlKey:document.getElementById('subdlKey').value.trim(),wyzieKey:document.getElementById('wyzieKey').value.trim()};return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(p)))));}function installAddon(){const b=buildConfigString();const c=document.getElementById('copyBtn');if(c)c.style.display='flex';window.location.href='stremio://'+window.location.host+'/'+b+'/manifest.json';}function copyManifestUrl(){const u='https://'+window.location.host+'/'+buildConfigString()+'/manifest.json';navigator.clipboard.writeText(u).then(()=>alert('تم نسخ الرابط!')).catch(()=>prompt('انسخ:',u));}</script></body></html>`;
}

app.get(['/', '/configure', '/:config/configure'], (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(renderHtml(parseConfig(req))); });
app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Content-Type', 'application/json'); res.json({ ...MANIFEST, behaviorHints: { configurable: true, configurationRequired: !req.params.config } }); });

app.get(['/subtitles/:type/:id', '/subtitles/:type/:id/:extra', '/:config/subtitles/:type/:id', '/:config/subtitles/:type/:id/:extra'], async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Content-Type', 'application/json');
  let targetId = req.params.id || ''; if (targetId.endsWith('.json')) targetId = targetId.slice(0, -5);
  const type = req.params.type; const config = parseConfig(req); const baseUrl = getBaseUrl(req);

  try {
    const media = await resolveMedia(targetId, type);
    const imdbId = media.imdbId; const season = media.season; const episode = media.episode; const title = media.title || imdbId; const mediaType = media.type || type;
    const tasks = [getAnimeSubtitles(targetId, episode, config.jimakuKey, title).catch(() => [])];

    if (imdbId) {
      tasks.push(getOpenSubtitles({ imdbId, season, episode, type: mediaType, apiKey: config.openSubtitlesKey }).catch(() => []));
      tasks.push(getSubDL({ imdbId, season, episode, type: mediaType, apiKey: config.subdlKey }).catch(() => []));
    }
    if (config.subsourceKey && (title || imdbId)) tasks.push(getSubSource({ title, imdbId, season, episode, type: mediaType, apiKey: config.subsourceKey }).catch(() => []));
    if (getWyzie && imdbId) tasks.push(getWyzie({ imdbId, season, episode, type: mediaType, apiKey: config.wyzieKey }).catch(() => []));

    const settled = await Promise.allSettled(tasks);
    const allSubs = settled.filter(r => r.status === 'fulfilled').flatMap(r => r.value).filter(s => s && s.url);
    const sourceCounters = {};

    const formatted = allSubs.map((s) => {
      let finalUrl = s.url; const ext = detectFormat(s); const isAssTrack = ext === 'ssa'; const rawSource = (s._source || '').toLowerCase(); let siteName = 'Subtitles';
      if (rawSource.includes('opensubtitles')) siteName = 'OpenSubtitles'; else if (rawSource.includes('subdl')) siteName = 'SubDL'; else if (rawSource.includes('subsource')) siteName = 'SubSource'; else if (rawSource.includes('wyzie')) siteName = 'Wyzie'; else if (rawSource.includes('animetosho') || rawSource.includes('anime')) siteName = 'AnimeTosho'; else if (rawSource.includes('jimaku')) siteName = 'Jimaku';
      const groupKey = `${siteName}-${ext}`; sourceCounters[groupKey] = (sourceCounters[groupKey] || 0) + 1; const count = sourceCounters[groupKey];
      const isActuallyZip = s._isZip === true || s.url.toLowerCase().endsWith('.zip');

      if (isActuallyZip) finalUrl = `${baseUrl}/stream-zip.${ext}?url=${encodeURIComponent(s.url)}&ep=${s._episode || episode || 1}`;
      else if (s.url.startsWith('subsource://')) finalUrl = `${baseUrl}/stream-subsource.${ext}?data=${encodeURIComponent(s.url)}`;
      else if (s.url.startsWith('os://')) finalUrl = `${baseUrl}/stream-os.${ext}?data=${encodeURIComponent(s.url)}&key=${encodeURIComponent(config.openSubtitlesKey || '')}`;
      else if (isAssTrack && !finalUrl.toLowerCase().endsWith('.ssa') && !finalUrl.toLowerCase().endsWith('.ass')) finalUrl = `${baseUrl}/stream-proxy.ssa?url=${encodeURIComponent(finalUrl)}`;
      else if (rawSource.includes('opensubtitles') || finalUrl.includes('opensubtitles') || finalUrl.includes('strem.io')) finalUrl = `${baseUrl}/stream-proxy.srt?url=${encodeURIComponent(finalUrl)}`;

      return { id: `nuvio-${ext}-${rawSource.replace(/[^a-z0-9]/g, '') || siteName.toLowerCase()}-ara-${count}`, url: finalUrl, lang: s.lang || 'ara', format: ext, _priority: s._priority !== undefined ? s._priority : (isAssTrack ? 0 : 2) };
    });

    formatted.sort((a, b) => {
      if (a._priority !== b._priority) return a._priority - b._priority;
      const aIsAr = a.lang === 'ara' || a.lang === 'ar'; const bIsAr = b.lang === 'ara' || b.lang === 'ar';
      if (aIsAr && !bIsAr) return -1; if (!aIsAr && bIsAr) return 1; return 0;
    });

    const seenUrls = new Set();
    const uniqueSubs = formatted.filter(s => { if (seenUrls.has(s.url)) return false; seenUrls.add(s.url); return true; });

    // --- نظام الترجمة الذكي بالخلفية ---
    const transSubs = [];
    let bestSource = uniqueSubs.find(s => (s.lang === 'eng' || s.lang === 'en') && s.url) || uniqueSubs.find(s => s.url); 
    if (bestSource) {
      const aiUrl = `${bestSource.url}&translate=true`;
      transSubs.push({ id: `trans-ai-1`, url: aiUrl, lang: 'ara', format: bestSource.format, _priority: 10 });
      transSubs.push({ id: `trans-ai-2`, url: aiUrl, lang: 'ara', format: bestSource.format, _priority: 10 });
    }

    res.json({ subtitles: [...uniqueSubs, ...transSubs] });
  } catch (err) { res.json({ subtitles: [] }); }
});

app.all(['/stream-proxy', '/stream-proxy.srt', '/stream-proxy.ass', '/stream-proxy.ssa'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const targetUrl = req.query.url; if (!targetUrl) return res.status(400).send('Missing URL');
  try {
    const response = await axios.get(targetUrl, { responseType: 'arraybuffer', timeout: 10000 });
    let buffer = Buffer.from(response.data);
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = new AdmZip(buffer); const entries = zip.getEntries();
      const assEntry = entries.find(e => !e.isDirectory && (e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa')));
      const subEntry = entries.find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.srt'));
      if (assEntry) buffer = assEntry.getData(); else if (subEntry) buffer = subEntry.getData();
    }
    const fixedBuffer = fixArabicEncoding(buffer);
    const isAss = req.path.endsWith('.ass') || req.path.endsWith('.ssa') || fixedBuffer.slice(0, 500).toString('utf-8').includes('[Script Info]');
    return handleAiResponse(req, res, fixedBuffer, isAss);
  } catch (e) { res.status(500).send('Error proxying subtitle'); }
});

app.all(['/stream-os', '/stream-os.srt', '/stream-os.ass', '/stream-os.ssa'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const dataUrl = req.query.data || ''; const apiKey = req.query.key || '';
  if (!dataUrl || !apiKey) return res.status(400).send('Missing data or apiKey');
  try {
    const parsed = new URL(dataUrl.replace('os://', 'http://dummy.com/'));
    const fileId = parseInt(parsed.pathname.replace('/', ''), 10);
    const formatParam = (parsed.searchParams.get('format') || 'srt').toLowerCase();
    const dlRes = await axios.post('https://api.opensubtitles.com/api/v1/download', { file_id: fileId }, { headers: { 'Api-Key': apiKey.trim(), 'User-Agent': 'NuvioSubtitles v1.0.0', 'Content-Type': 'application/json' }, timeout: 8000 });
    const directLink = dlRes.data?.link; if (!directLink) return res.status(404).send('Download link not found');
    const fileRes = await axios.get(directLink, { responseType: 'arraybuffer', timeout: 10000 });
    let buffer = Buffer.from(fileRes.data);
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = new AdmZip(buffer); const entries = zip.getEntries();
      const assEntry = entries.find(e => !e.isDirectory && (e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa')));
      const subEntry = entries.find(e => !e.isDirectory && (e.entryName.toLowerCase().endsWith('.srt') || e.entryName.toLowerCase().endsWith('.vtt')));
      if (assEntry) buffer = assEntry.getData(); else if (subEntry) buffer = subEntry.getData();
    }
    const fixedBuffer = fixArabicEncoding(buffer);
    const isAss = formatParam === 'ass' || formatParam === 'ssa' || fixedBuffer.slice(0, 500).toString('utf-8').includes('[Script Info]');
    return handleAiResponse(req, res, fixedBuffer, isAss);
  } catch (e) { res.status(500).send('Error streaming OpenSubtitles'); }
});

app.all(['/stream-zip', '/stream-zip.srt', '/stream-zip.ass', '/stream-zip.ssa'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const zipUrl = req.query.url; const ep = req.query.ep || '1';
  if (!zipUrl) return res.status(400).send('Missing URL');
  try {
    const response = await axios.get(zipUrl, { responseType: 'arraybuffer', timeout: 10000 });
    const zip = new AdmZip(Buffer.from(response.data));
    const entry = findEpisodeInZip(zip, ep);
    if (!entry) return res.status(404).send('Episode not found in archive');
    const fixedBuffer = fixArabicEncoding(entry.getData());
    const isAss = entry.entryName.toLowerCase().endsWith('.ass') || entry.entryName.toLowerCase().endsWith('.ssa');
    return handleAiResponse(req, res, fixedBuffer, isAss);
  } catch (e) { res.status(500).send('Error extracting ZIP'); }
});

app.all(['/stream-subsource', '/stream-subsource.srt', '/stream-subsource.ass', '/stream-subsource.ssa'], async (req, res) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const dataUrl = req.query.data; if (!dataUrl) return res.status(400).send('Missing data');
  try {
    const buffer = await fetchSubSourceBuffer(dataUrl); let finalBuffer = buffer; let isAss = dataUrl.includes('.ass') || dataUrl.includes('.ssa');
    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = new AdmZip(buffer); const entries = zip.getEntries();
      const subEntry = entries.find(e => !e.isDirectory && (e.entryName.endsWith('.srt') || e.entryName.endsWith('.ass') || e.entryName.endsWith('.ssa')));
      if (subEntry) { finalBuffer = subEntry.getData(); isAss = subEntry.entryName.toLowerCase().endsWith('.ass') || subEntry.entryName.toLowerCase().endsWith('.ssa'); }
    }
    finalBuffer = fixArabicEncoding(finalBuffer);
    if (finalBuffer.slice(0, 300).toString('utf-8').includes('[Script Info]')) isAss = true;
    return handleAiResponse(req, res, finalBuffer, isAss);
  } catch (e) { res.status(500).send('Error streaming SubSource'); }
});

if (process.env.NODE_ENV !== 'production') { app.listen(PORT, () => console.log(`Server listening on port ${PORT}`)); }
module.exports = app;
