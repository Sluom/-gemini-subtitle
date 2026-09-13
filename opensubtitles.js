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
    timeout: 8000
  };
}

async function fetchOpenSubOfficial(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const params = new URLSearchParams({
      imdb_id: imdbId.replace('tt', ''),
      languages: 'ar,en'
    });

    if (season) params.set('season_number', season);
    if (episode) params.set('episode_number', episode);

    const res = await axios.get(
      `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`,
      getAxiosConfig({ 'Api-Key': apiKey.trim() })
    );

    const items = (res.data?.data || []).slice(0, 3);
    const downloadTasks = items.map(async (item) => {
      const fileId = item.attributes?.files?.[0]?.file_id;
      const fileName = item.attributes?.files?.[0]?.file_name || item.attributes?.release || 'OpenSubtitles VIP';
      if (!fileId) return null;

      try {
        const dlRes = await axios.post(
          'https://api.opensubtitles.com/api/v1/download',
          { file_id: fileId },
          getAxiosConfig({
            'Api-Key': apiKey.trim(),
            'Content-Type': 'application/json'
          })
        );

        if (dlRes.data?.link) {
          return {
            url: dlRes.data.link,
            lang: item.attributes?.language || 'ara',
            origName: fileName,
            _source: 'opensub-official',
            _priority: 1
          };
        }
      } catch (e) {
        return null;
      }
      return null;
    });

    const settled = await Promise.allSettled(downloadTasks);
    return settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  } catch (err) {
    return [];
  }
}

async function fetchOpenSubMirror(url, sourceKey) {
  try {
    const res = await axios.get(url, getAxiosConfig());
    const subs = res.data?.subtitles || [];

    return subs.map(s => ({
      url: s.url,
      lang: s.lang || 'ara',
      origName: s.title || s.SubFileName || s.name || 'OpenSubtitles',
      _source: sourceKey,
      _priority: 2
    }));
  } catch (err) {
    return [];
  }
}

async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const mediaType = season ? 'series' : (type === 'series' ? 'series' : 'movie');
  const mirrorTargetId = season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

  const requests = [
    fetchOpenSubMirror(`https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${mirrorTargetId}.json`, 'opensub-v3'),
    fetchOpenSubMirror(`https://opensubtitles.strem.fun/subtitles/${mediaType}/${mirrorTargetId}.json`, 'opensub-fun')
  ];

  if (apiKey) {
    requests.push(fetchOpenSubOfficial(imdbId, season, episode, apiKey));
  }

  const results = await Promise.allSettled(requests);

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getOpenSubtitles };
