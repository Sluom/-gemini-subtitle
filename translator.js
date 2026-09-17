const axios = require('axios');
const iconv = require('iconv-lite');

const translationCache = new Map();

// مفتاح ورابط APInex الثابت
const APINEX_BASE_URL = 'https://api.apinex.bond/v1/chat/completions';
const APINEX_API_KEY = 'sk-apxf8963dbb2a56ef32027e48d2168c34609153354867ceae7';
const APINEX_MODEL = 'gemini-1.5-flash';

const ASS_DEFAULT_HEADER = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,26,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function srtTimeToAss(t) {
  const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return '0:00:00.00';
  const h = parseInt(m[1], 10);
  const cs = Math.floor(parseInt(m[4], 10) / 10).toString().padStart(2, '0');
  return `${h}:${m[2]}:${m[3]}.${cs}`;
}

function safeDecodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return iconv.decode(buf, 'win1256');
    } catch (e2) {
      return buf.toString('utf8');
    }
  }
}

function extractCuesUniversal(text) {
  const assLines = text.split(/\r?\n/).filter(l => /^Dialogue:/i.test(l.trim()));
  if (assLines.length > 0) {
    const cues = [];
    for (const line of assLines) {
      const m = line.match(/^Dialogue:\s*[^,]*,([^,]*),([^,]*),(?:[^,]*,){6}(.*)$/i);
      if (m) cues.push({ start: m[1].trim(), end: m[2].trim(), text: m[3] });
    }
    if (cues.length) return cues;
  }
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length);
    if (lines.length < 2) continue;
    let idx = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const tm = (lines[idx] || '').match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
    if (!tm) continue;
    const text2 = lines.slice(idx + 1).join('\\N');
    if (text2.trim()) cues.push({ start: srtTimeToAss(tm[1]), end: srtTimeToAss(tm[2]), text: text2 });
  }
  return cues;
}

function parseRobustJsonArray(raw, expectedLength) {
  if (!raw) return null;
  let clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(clean);
    const arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.data || Object.values(parsed));
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map(x => String(x || '').trim());
    }
  } catch (e) {
    const stringMatches = [...clean.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]);
    if (stringMatches.length >= expectedLength * 0.5) {
      return stringMatches.filter(s => s !== 'translations' && s !== 'data');
    }
  }
  return null;
}

async function runConcurrentPool(tasks, limit = 2) {
  const results = new Array(tasks.length);
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      try {
        results[current] = await tasks[current]();
      } catch (err) {
        results[current] = null;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function translateChunkStrict(texts, keys) {
  const prompt = `You are an automated subtitle translator. Target Language: ARABIC ONLY.
Task: Translate the JSON array of strings into Arabic.
Rules:
1. Return a JSON object with key "translations" containing the Arabic strings array.
2. DO NOT use double quotes inside strings.
3. NEVER output English words.
Length: ${texts.length}.
Input: ${JSON.stringify(texts)}`;

  // 1. استخدام APInex كمصدر أساسي للترجمة
  try {
    const r = await axios.post(
      APINEX_BASE_URL,
      {
        model: APINEX_MODEL,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          Authorization: `Bearer ${APINEX_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    const parsedArr = parseRobustJsonArray(r.data?.choices?.[0]?.message?.content, texts.length);
    if (parsedArr && parsedArr.length > 0) return parsedArr;
  } catch (e) {
    console.error('[APInex Translation Error]', e.message);
  }

  // 2. استخدام Groq كبديل احتياطي في حال فشل APInex
  if (keys && keys.groqKey) {
    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            Authorization: `Bearer ${keys.groqKey.trim()}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      const parsedArr = parseRobustJsonArray(r.data?.choices?.[0]?.message?.content, texts.length);
      if (parsedArr && parsedArr.length > 0) return parsedArr;
    } catch (e) {}
  }

  return null;
}

// دالة لتوليد ترجمة SRT
async function handleTranslationSrt(subUrl, keys) {
  const cacheKey = `${subUrl}_translated_ar_srt`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const r = await axios.get(subUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const originalText = safeDecodeText(Buffer.from(r.data));
  const cues = extractCuesUniversal(originalText);

  if (!cues.length) return "1\n00:00:01,000 --> 00:00:08,000\n[النظام] تعذر استخراج النصوص للترجمة.\n";

  const CHUNK = 40;
  const chunks = [];
  for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

  const tasks = chunks.map(chunk => async () => {
    const texts = chunk.map(c => c.text);
    const translated = await translateChunkStrict(texts, keys);
    return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : "ـ");
  });

  const chunkResults = await runConcurrentPool(tasks, 3); // رفعنا سرعة المهام إلى 3 بسبب سرعة APInex
  const finalTranslations = chunkResults.flat();
  
  let srtOutput = '';
  cues.forEach((c, idx) => {
    // تحويل توقيت ASS (الناتج من extractCuesUniversal) إلى SRT
    let sTime = c.start.replace('.', ',');
    let eTime = c.end.replace('.', ',');
    if (sTime.length === 10) sTime = '0' + sTime;
    if (eTime.length === 10) eTime = '0' + eTime;
    if (sTime.split(',')[1].length === 2) sTime += '0';
    if (eTime.split(',')[1].length === 2) eTime += '0';

    srtOutput += `${idx + 1}\n${sTime} --> ${eTime}\n${finalTranslations[idx] || 'ـ'}\n\n`;
  });

  translationCache.set(cacheKey, srtOutput);
  return srtOutput;
}

// دالة لتوليد ترجمة ASS (الكود الأصلي مالتك)
async function handleTranslationAss(subUrl, keys) {
  const cacheKey = `${subUrl}_translated_ar_ass`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const r = await axios.get(subUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const originalText = safeDecodeText(Buffer.from(r.data));
  const cues = extractCuesUniversal(originalText);

  if (!cues.length) return ASS_DEFAULT_HEADER + `Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,[النظام] تعذر استخراج نصوص الترجمة المصدر.`;

  const CHUNK = 40;
  const chunks = [];
  for (let i = 0; i < cues.length; i += CHUNK) chunks.push(cues.slice(i, i + CHUNK));

  const tasks = chunks.map(chunk => async () => {
    const texts = chunk.map(c => c.text);
    const translated = await translateChunkStrict(texts, keys);
    return chunk.map((_, idx) => (translated && translated[idx]) ? translated[idx] : "ـ");
  });

  const chunkResults = await runConcurrentPool(tasks, 3); // رفعنا سرعة المهام إلى 3
  const finalTranslations = chunkResults.flat();
  const assLines = cues.map((c, idx) => `Dialogue: 0,${c.start},${c.end},Default,,0,0,0,,${finalTranslations[idx] || 'ـ'}`);

  const finalAssOutput = ASS_DEFAULT_HEADER + assLines.join('\n') + '\n';
  translationCache.set(cacheKey, finalAssOutput);
  return finalAssOutput;
}

module.exports = { handleTranslationSrt, handleTranslationAss };
