const axios = require('axios');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 8000;

function getHeaders() {
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
  };
}

function isForcedOrSignsOnly(trackName = '') {
  const name = trackName.toLowerCase();
  return (
    name.includes('signs') ||
    name.includes('forced') ||
    name.includes('songs') ||
    name.includes('s&s')
  );
}

async function fetchAnimeToshoSubtitles(title, episode) {
  if (!title) return [];

  const epNum = parseInt(episode || 1, 10);
  const cleanTitle = title.replace(/[^\w\s]/gi, ' ').trim();
  const query = `${cleanTitle} ${epNum < 10 ? '0' + epNum : epNum}`;

  try {
    const searchUrl = `https://animetosho.org/search?q=${encodeURIComponent(query)}&json=1`;
    const res = await axios.get(searchUrl, { headers: getHeaders(), timeout: TIMEOUT });
    const entries = Array.isArray(res.data) ? res.data : [];

    if (!entries.length) return [];

    const results = [];
    const seenAttachments = new Set();
    const topEntries = entries.slice(0, 3);

    for (const entry of topEntries) {
      if (!entry.id) continue;

      try {
        const detailUrl = `https://animetosho.org/view/${entry.id}?json=1`;
        const detailRes = await axios.get(detailUrl, { headers: getHeaders(), timeout: 4000 });
        const detail = detailRes.data || {};
        const files = detail.files || [];

        for (const file of files) {
          const attachments = file.attachments || [];
          const subs = attachments.filter(a => a.type === 'subtitle');

          for (const sub of subs) {
            if (seenAttachments.has(sub.id)) continue;

            const lang = (sub.info?.lang || sub.lang || '').toLowerCase();
            const isArabic = lang === 'ara' || lang === 'ar' || lang === 'arabic';

            if (!isArabic) continue;

            const trackName = sub.info?.name || sub.name || '';
            if (isForcedOrSignsOnly(trackName)) continue;

            seenAttachments.add(sub.id);

            const codec = (sub.info?.codec || '').toLowerCase();
            const isAss = codec === 'ass' || codec === 'ssa' || (sub.filename || '').endsWith('.ass');
            const format = isAss ? 'ass' : 'srt';

            // توجيه الرابط الخام مباشرة إلى سيرفرنا بـ index.js لفك الضغط وتعديل الترميز
            const rawUrl = `https://animetosho.org/storage/attachment/${sub.id}`;

            results.push({
              url: rawUrl,
              lang: 'ara',
              format: format,
              ext: format,
              fileName: sub.filename || `${entry.title || 'Anime'} [E${epNum}] [${format.toUpperCase()}]`,
              origName: entry.title || 'AnimeTosho',
              _source: 'animetosho',
              _priority: isAss ? 0 : 1
            });
          }
        }
      } catch (innerErr) {}
    }

    return results;
  } catch (err) {
    return [];
  }
}

async function getAnimeSubtitles(targetId, episode, jimakuKey, title) {
  const subs = [];

  try {
    const toshoSubs = await fetchAnimeToshoSubtitles(title, episode);
    subs.push(...toshoSubs);
  } catch (e) {}

  if (jimakuKey && title) {
    try {
      const jUrl = `https://jimaku.cc/api/entries/search?query=${encodeURIComponent(title)}`;
      const jRes = await axios.get(jUrl, {
        headers: { 'Authorization': jimakuKey.trim(), ...getHeaders() },
        timeout: 5000
      });
      const entries = jRes.data || [];

      for (const entry of entries.slice(0, 2)) {
        if (entry.download_url) {
          subs.push({
            url: entry.download_url,
            lang: 'ara',
            format: 'ass',
            ext: 'ass',
            fileName: entry.name || `${title} - Jimaku`,
            origName: 'Jimaku',
            _source: 'jimaku',
            _priority: 0
          });
        }
      }
    } catch (e) {}
  }

  return subs;
}

module.exports = { getAnimeSubtitles };
