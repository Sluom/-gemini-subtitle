const axios = require('axios');

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
    timeout: 10000
  };
}

async function fetchJimakuDirect(anilistId, apiKey) {
  if (!apiKey || !anilistId) return [];
  try {
    const s = await axios.get(
      `https://jimaku.cc/api/entries/search?anilist_id=${anilistId}`,
      getAxiosConfig({ 'Authorization': apiKey.trim() })
    );
    const entryId = s.data?.[0]?.id;
    if (!entryId) return [];

    const f = await axios.get(
      `https://jimaku.cc/api/entries/${entryId}/files`,
      getAxiosConfig({ 'Authorization': apiKey.trim() })
    );

    const files = (Array.isArray(f.data) ? f.data : []).filter(file =>
      /\.(ass|ssa|srt|vtt|zip)$/i.test(file.name || file.url || '')
    );

    return files.map(file => ({
      url: file.url,
      lang: 'ara',
      origName: file.name || 'Jimaku Anime',
      _source: 'jimaku',
      _priority: 1
    }));
  } catch (e) {
    return [];
  }
}

async function fetchAnimeMirror(url, sourceKey) {
  try {
    const r = await axios.get(url, getAxiosConfig());
    return (r.data?.subtitles || []).map(s => ({
      url: s.url,
      lang: s.lang || 'ara',
      origName: s.title || s.name || sourceKey,
      _source: sourceKey,
      _priority: 2
    }));
  } catch (e) {
    return [];
  }
}

async function getAnimeSubtitles({ targetId, type, apiKey }) {
  const isAnimeTarget = targetId.startsWith('kitsu') || 
                       targetId.startsWith('anilist') || 
                       targetId.startsWith('mal') || 
                       type === 'anime';

  if (!isAnimeTarget) return [];

  const requests = [];

  requests.push(
    fetchAnimeMirror(`https://anime-subtitles.strem.fun/subtitles/series/${targetId}.json`, 'anime-subs'),
    fetchAnimeMirror(`https://kitsunekko-subtitles.strem.fun/subtitles/series/${targetId}.json`, 'kitsunekko')
  );

  if (apiKey && (targetId.startsWith('anilist') || targetId.startsWith('kitsu'))) {
    const rawId = targetId.split(':')[1] || targetId.replace(/^[a-z]+:/i, '');
    requests.push(fetchJimakuDirect(rawId, apiKey));
  }

  const results = await Promise.allSettled(requests);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getAnimeSubtitles };

