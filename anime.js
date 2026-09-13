const axios = require('axios');

const animeCache = new Map();

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getAxiosConfig(extraHeaders = {}) {
  return {
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': '*/*',
      ...extraHeaders
    },
    timeout: 4500
  };
}

async function getKitsuAnimeInfo(kitsuId) {
  if (animeCache.has(kitsuId)) {
    return animeCache.get(kitsuId);
  }

  try {
    const res = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, getAxiosConfig());
    const attrs = res.data?.data?.attributes;
    const info = {
      canonicalTitle: attrs?.canonicalTitle || null,
      englishTitle: attrs?.titles?.en || attrs?.titles?.en_jp || null
    };
    animeCache.set(kitsuId, info);
    return info;
  } catch (e) {
    return { canonicalTitle: null, englishTitle: null };
  }
}

async function fetchKitsuMirrors(targetId) {
  const cleanId = targetId.trim();
  const endpoints = [
    `https://anime-kitsu.strem.fun/subtitles/anime/${cleanId}.json`,
    `https://anime-kitsu.strem.fun/subtitles/series/${cleanId}.json`,
    `https://anime-kitsu.strem.fun/subtitles/movie/${cleanId}.json`
  ];

  const requests = endpoints.map(async (url) => {
    try {
      const res = await axios.get(url, getAxiosConfig());
      return (res.data?.subtitles || []).map(s => ({
        url: s.url,
        lang: (s.lang || 'ara').toLowerCase(),
        origName: s.title || s.name || 'Kitsu Mirror',
        _source: 'kitsu-mirror',
        _priority: 1
      }));
    } catch (e) {
      return [];
    }
  });

  const settled = await Promise.allSettled(requests);
  return settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
}

async function fetchAnimeTosho(title, episode) {
  if (!title) return [];
  const epStr = String(episode).padStart(2, '0');
  const query = `${title} ${epStr}`;

  try {
    const url = `https://feed.animetosho.org/json?only_tor=1&q=${encodeURIComponent(query)}`;
    const res = await axios.get(url, getAxiosConfig());
    const entries = res.data || [];
    const results = [];

    for (const item of entries.slice(0, 5)) {
      const attachments = item.attachments || [];
      for (const att of attachments) {
        const name = (att.filename || '').toLowerCase();
        if ((name.endsWith('.ass') || name.endsWith('.srt')) && (name.includes('ara') || name.includes('arabic') || name.includes('ar.'))) {
          let directUrl = att.link || '';
          if (directUrl && !directUrl.startsWith('http')) {
            directUrl = `https://animetosho.org${directUrl.startsWith('/') ? '' : '/'}${directUrl}`;
          }
          results.push({
            url: directUrl,
            lang: 'ara',
            origName: att.filename || item.title || 'AnimeTosho [ASS]',
            _source: 'animetosho',
            _priority: 1
          });
        }
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

async function fetchJimaku(title) {
  if (!title) return [];
  try {
    const searchUrl = `https://jimaku.cc/api/entries/search?query=${encodeURIComponent(title)}`;
    const res = await axios.get(searchUrl, getAxiosConfig());
    const entries = res.data || [];
    if (!entries.length) return [];

    const entryId = entries[0].id;
    if (!entryId) return [];

    const filesRes = await axios.get(`https://jimaku.cc/api/entries/${entryId}/files`, getAxiosConfig());
    const files = filesRes.data || [];

    return files
      .filter(f => {
        const lang = (f.language || '').toLowerCase();
        const name = (f.name || '').toLowerCase();
        return lang.includes('ar') || name.includes('arabic') || name.includes('ara');
      })
      .slice(0, 3)
      .map(f => ({
        url: f.url || `https://jimaku.cc/api/files/${f.id}/download`,
        lang: 'ara',
        origName: f.name || 'Jimaku Anime Subs',
        _source: 'jimaku',
        _priority: 1
      }));
  } catch (e) {
    return [];
  }
}

async function getAnimeSubtitles(targetId) {
  if (!targetId || !targetId.startsWith('kitsu:')) {
    return [];
  }

  const parts = targetId.split(':');
  const kitsuId = parts[1];
  const episode = parts[2] ? parseInt(parts[2], 10) : 1;

  const infoPromise = getKitsuAnimeInfo(kitsuId);
  const mirrorsPromise = fetchKitsuMirrors(targetId);

  const [info, mirrorsResult] = await Promise.all([infoPromise, mirrorsPromise]);
  const mainTitle = info.englishTitle || info.canonicalTitle;

  const dynamicTasks = [];
  if (mainTitle) {
    dynamicTasks.push(fetchAnimeTosho(mainTitle, episode));
    dynamicTasks.push(fetchJimaku(mainTitle));
  }

  const dynamicResults = await Promise.allSettled(dynamicTasks);
  const extraSubs = dynamicResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  return [...mirrorsResult, ...extraSubs].filter(s => s && s.url);
}

module.exports = { getAnimeSubtitles };
