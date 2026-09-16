const axios = require('axios');

function getAnimeHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  };
}

async function getKitsuIdFromImdb(imdbId) {
  if (!imdbId || !imdbId.startsWith('tt')) return null;
  try {
    const res = await axios.get(`https://kitsu.io/api/edge/mappings?filter[externalSite]=imdb&filter[externalId]=${imdbId}&include=item`, {
      headers: getAnimeHeaders(),
      timeout: 6000
    });
    const item = res.data?.included?.[0] || res.data?.data?.[0];
    return item ? item.id : null;
  } catch (e) {
    return null;
  }
}

async function searchKitsuIdByTitle(title) {
  if (!title) return null;
  try {
    const cleanTitle = title.replace(/\([^)]*\)/g, '').replace(/season \d+/i, '').trim();
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
    const epRegex = new RegExp(`(?:e|ep|episode|[._ -]|\\[|\\()0*${epNum}(?:[\\]\\)\\s._-]|$|v\\d+)`, 'i');

    for (const item of items) {
      const title = (item.title || '').toLowerCase();

      if (epRegex.test(title) && Array.isArray(item.attachments) && item.attachments.length) {
        for (const att of item.attachments) {
          const attName = (att.filename || '').toLowerCase();
          const isAss = attName.endsWith('.ass');
          const isSrt = attName.endsWith('.srt');

          if (isAss || isSrt) {
            const isArabic = attName.includes('ara') || attName.includes('arabic') || attName.includes('ar.');
            
            subs.push({
              id: `tosho_${att.id || Math.random().toString(36).substring(7)}`,
              url: att.url,
              lang: isArabic ? 'ara' : 'eng',
              format: isAss ? 'ass' : 'srt',
              _source: 'animetosho',
              _priority: isArabic ? (isAss ? 0 : 1) : 3
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
  let target = targetId;
  let episode = episodeNum;
  let title = mediaTitle;

  if (typeof targetId === 'object' && targetId !== null) {
    target = targetId.targetId || targetId.id || '';
    episode = targetId.episode || episodeNum;
    title = targetId.title || mediaTitle;
  }

  let kitsuId = null;

  if (typeof target === 'string' && target.startsWith('kitsu:')) {
    const parts = target.split(':');
    kitsuId = parts[1];
    if (parts[2]) episode = parts[2];
  } else if (typeof target === 'string' && target.startsWith('tt')) {
    kitsuId = await getKitsuIdFromImdb(target);
  }

  if (!kitsuId && title) {
    kitsuId = await searchKitsuIdByTitle(title);
  }

  if (!kitsuId) return [];

  const results = await getAnimeToshoSubtitles(kitsuId, episode);
  return results.filter(s => s && s.url);
}

module.exports = { getAnimeSubtitles };
