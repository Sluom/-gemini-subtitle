const axios = require('axios');

const mapperCache = new Map();

const http = axios.create({
  timeout: 4000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

async function getCinemetaMeta(imdbId, type) {
  try {
    const metaType = type === 'series' ? 'series' : 'movie';
    const r = await http.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdbId}.json`);
    return r.data?.meta || null;
  } catch (e) {
    return null;
  }
}

async function findKitsuFromTitle(title) {
  if (!title) return null;
  try {
    const r = await http.get(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=1`);
    const item = r.data?.data?.[0];
    return item ? item.id : null;
  } catch (e) {
    return null;
  }
}

async function resolveMedia(targetId, type) {
  if (!targetId) {
    return { imdbId: null, season: null, episode: null, kitsuId: null, anilistId: null, title: null, type };
  }

  if (mapperCache.has(targetId)) {
    return mapperCache.get(targetId);
  }

  let imdbId = null;
  let kitsuId = null;
  let anilistId = null;
  let title = null;
  let season = null;
  let episode = null;
  let detectedType = type || 'movie';

  if (targetId.startsWith('tt')) {
    const parts = targetId.split(':');
    imdbId = parts[0];
    season = parts[1] ? parseInt(parts[1], 10) : null;
    episode = parts[2] ? parseInt(parts[2], 10) : null;
    detectedType = season ? 'series' : (type || 'movie');

    const meta = await getCinemetaMeta(imdbId, detectedType);
    if (meta) {
      title = meta.name || null;
      const isAnime = (meta.genres || []).some(g => /anime|animation/i.test(g));
      if (isAnime && title) {
        kitsuId = await findKitsuFromTitle(title);
      }
    }
  } else if (targetId.startsWith('kitsu:')) {
    const parts = targetId.split(':');
    kitsuId = parts[1];
    episode = parts[2] ? parseInt(parts[2], 10) : 1;
    season = 1;
    detectedType = 'series';

    try {
      const r = await http.get(`https://anime-kitsu.strem.fun/meta/anime/kitsu:${kitsuId}.json`);
      const meta = r.data?.meta;
      if (meta) {
        title = meta.name || null;
        if (meta.imdb_id && meta.imdb_id.startsWith('tt')) {
          imdbId = meta.imdb_id;
        }
      }
    } catch (e) {}

    if (!imdbId) {
      try {
        const r = await http.get(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`);
        const maps = r.data?.data || [];
        const imdbMap = maps.find(m => (m.attributes?.externalSite || '').toLowerCase().includes('imdb'));
        if (imdbMap?.attributes?.externalId) {
          const raw = imdbMap.attributes.externalId;
          imdbId = raw.startsWith('tt') ? raw : `tt${raw}`;
        }
        const aniMap = maps.find(m => (m.attributes?.externalSite || '').toLowerCase().includes('anilist'));
        if (aniMap?.attributes?.externalId) {
          anilistId = aniMap.attributes.externalId;
        }
      } catch (e) {}
    }

    if (!imdbId && title) {
      try {
        const r = await http.get(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(title)}.json`);
        const item = r.data?.metas?.[0];
        if (item?.id && item.id.startsWith('tt')) {
          imdbId = item.id;
        }
      } catch (e) {}
    }
  }

  const result = {
    imdbId,
    season,
    episode,
    kitsuId,
    anilistId,
    title,
    type: detectedType
  };

  mapperCache.set(targetId, result);
  return result;
}

module.exports = { resolveMedia };
