const axios = require('axios');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getAxiosConfig() {
  return {
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': '*/*'
    },
    timeout: 7000
  };
}

async function fetchKitsuMirror(url, sourceKey) {
  try {
    const res = await axios.get(url, getAxiosConfig());
    const subs = res.data?.subtitles || [];
    return subs.map(s => ({
      url: s.url,
      lang: (s.lang || 'ara').toLowerCase(),
      origName: s.title || s.name || 'Anime Subs',
      _source: sourceKey,
      _priority: 1
    }));
  } catch (err) {
    return [];
  }
}

async function getAnimeSubtitles(targetId) {
  if (!targetId || !targetId.startsWith('kitsu:')) {
    return [];
  }

  const cleanId = targetId.trim();
  const endpoints = [
    fetchKitsuMirror(`https://anime-kitsu.strem.fun/subtitles/anime/${cleanId}.json`, 'kitsu-fun-anime'),
    fetchKitsuMirror(`https://anime-kitsu.strem.fun/subtitles/series/${cleanId}.json`, 'kitsu-fun-series'),
    fetchKitsuMirror(`https://anime-kitsu.strem.fun/subtitles/movie/${cleanId}.json`, 'kitsu-fun-movie')
  ];

  const results = await Promise.allSettled(endpoints);

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getAnimeSubtitles };
