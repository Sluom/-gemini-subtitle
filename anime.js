const axios = require('axios');

function getAnimeHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
  };
}

async function searchKitsuIdByTitle(title) {
  if (!title) return null;
  try {
    const cleanTitle = title.replace(/\([^)]*\)/g, '').trim();
    const res = await axios.get(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(cleanTitle)}&page[limit]=1`, {
      headers: getAnimeHeaders(),
      timeout: 6000
    });
    const item = res.data?.data?.[0];
    return item ? item.id : null;
  } catch (e) {
    return null;
  }
}

async function getKitsuAnime(kitsuId) {
  if (!kitsuId) return null;
  try {
    const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
      headers: getAnimeHeaders(),
      timeout: 6000
    });
    const attr = res.data?.data?.attributes;
    if (!attr) return null;
    return {
      canonicalTitle: attr.canonicalTitle,
      titles: attr.titles || {},
      slug: attr.slug
    };
  } catch (e) {
    return null;
  }
}

async function getJimakuSubtitles(query, apiKey) {
  if (!apiKey || !query) return [];
  try {
    const res = await axios.get(`https://jimaku.cc/api/entries/search?query=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': apiKey, ...getAnimeHeaders() },
      timeout: 6000
    });

    const entries = res.data?.data || res.data || [];
    if (!entries.length) return [];

    const firstEntry = entries[0];
    const filesRes = await axios.get(`https://jimaku.cc/api/entries/${firstEntry.id}/files`, {
      headers: { 'Authorization': apiKey, ...getAnimeHeaders() },
      timeout: 6000
    });

    const files = filesRes.data?.data || filesRes.data || [];
    return files.map((file, idx) => {
      const fileName = (file.name || '').toLowerCase();
      const isAss = fileName.endsWith('.ass');
      return {
        id: `jimaku_${file.id || idx}`,
        url: file.url || file.download_url,
        lang: 'ara',
        format: isAss ? 'ass' : 'srt',
        _source: 'jimaku',
        _priority: 3
      };
    }).filter(f => f.url);
  } catch (e) {
    return [];
  }
}

async function getAnimeToshoSubtitles(kitsuId, episode) {
  if (!kitsuId) return [];
  try {
    const epNum = parseInt(episode, 10) || 1;
    const res = await axios.get(`https://feed.animetosho.org/json?kitsu_id=${kitsuId}`, {
      headers: getAnimeHeaders(),
      timeout: 7000
    });

    const items = res.data || [];
    const subs = [];

    // مطابقة رقم الحلقة بمختلف الصيغ (E01, Ep 01, - 01, [01])
    const epRegex = new RegExp(`(?:e|ep|episode|[._ -]|\\[|\\()0*${epNum}(?:[\\]\\)\\s._-]|$|v\\d+)`, 'i');

    for (const item of items) {
      const title = (item.title || '').toLowerCase();
      
      if (epRegex.test(title) && item.attachments && item.attachments.length) {
        for (const att of item.attachments) {
          const attName = (att.filename || '').toLowerCase();
          if (attName.endsWith('.ass') || attName.endsWith('.srt')) {
            const isAss = attName.endsWith('.ass');
            const isArabic = attName.includes('ara') || attName.includes('arabic');
            
            subs.push({
              id: `tosho_${att.id || Math.random().toString(36).substring(7)}`,
              url: att.url,
              lang: isArabic ? 'ara' : 'jpn',
              format: isAss ? 'ass' : 'srt',
              _source: 'animetosho',
              _priority: 3
            });
          }
        }
      }
    }
    return subs;
  } catch (e) {
    return [];
  }
}

async function getAnimeSubtitles(targetId, episodeNum = 1, jimakuKey = '', mediaTitle = '') {
  if (!targetId && !mediaTitle) return [];

  // دعم الاستدعاء كـ Object أو كمتغيرات عادية
  let target = targetId;
  let episode = episodeNum;
  let key = jimakuKey;
  let title = mediaTitle;

  if (typeof targetId === 'object' && targetId !== null) {
    target = targetId.targetId || targetId.id || '';
    episode = targetId.episode || episodeNum;
    key = targetId.jimakuKey || targetId.apiKey || jimakuKey;
    title = targetId.title || mediaTitle;
  }

  let kitsuId = null;

  if (typeof target === 'string' && target.startsWith('kitsu:')) {
    const parts = target.split(':');
    kitsuId = parts[1];
    if (parts[2]) episode = parts[2];
  } else if (title) {
    kitsuId = await searchKitsuIdByTitle(title);
  }

  const tasks = [];

  if (kitsuId) {
    tasks.push(getAnimeToshoSubtitles(kitsuId, episode));

    if (key) {
      tasks.push(
        getKitsuAnime(kitsuId).then(kitsuData => {
          if (kitsuData) {
            const query = kitsuData.canonicalTitle || kitsuData.slug;
            return getJimakuSubtitles(query, key);
          }
          return [];
        })
      );
    }
  }

  const settled = await Promise.allSettled(tasks);
  return settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getAnimeSubtitles };
