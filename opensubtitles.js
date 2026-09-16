const axios = require('axios');

const USER_AGENT = 'NuvioSubtitles v1.0.0';
const TIMEOUT = 8000;

function getAxiosConfig(apiKey) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json'
  };
  if (apiKey) {
    headers['Api-Key'] = apiKey.trim();
  }
  return { headers, timeout: TIMEOUT };
}

// 1. فحص هل الترجمة بصيغة ASS
function checkIsAss(file, attr) {
  const fileName = (file.file_name || attr.release || '').toLowerCase();
  const format = (attr.format || '').toLowerCase();
  return (
    format === 'ass' ||
    format === 'ssa' ||
    fileName.endsWith('.ass') ||
    fileName.endsWith('.ssa')
  );
}

// 2. السحب عبر الـ API الرسمي بالمفتاح الخاص بك
async function fetchOfficial(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  const numericId = imdbId.replace(/^tt/, '');
  const params = new URLSearchParams({
    imdb_id: numericId,
    languages: 'ar,ara'
  });

  if (season != null && episode != null) {
    params.set('season_number', String(season));
    params.set('episode_number', String(episode));
  }

  try {
    const url = `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`;
    const res = await axios.get(url, getAxiosConfig(apiKey));
    const items = res.data?.data || [];

    const results = [];
    items.forEach(item => {
      const attr = item.attributes || {};
      const files = attr.files || [];

      files.forEach(file => {
        if (!file.file_id) return;

        const isAss = checkIsAss(file, attr);
        const format = isAss ? 'ass' : 'srt';
        const rawName = file.file_name || attr.release || 'OpenSubtitles';

        results.push({
          url: `os://${file.file_id}?format=${format}&name=${encodeURIComponent(rawName)}`,
          lang: 'ara',
          format: format,
          ext: format,
          fileName: rawName,
          origName: rawName,
          _source: 'opensubtitles',
          _priority: isAss ? 0 : 1
        });
      });
    });

    return results;
  } catch (err) {
    return [];
  }
}

// 3. السحب الاحتياطي عبر سيرفر Stremio في حال عدم توفر المفتاح
async function fetchMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const isSeries = type === 'series' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

    const url = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`;
    const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 6000 });
    const list = res.data?.subtitles || [];

    return list
      .filter(s => {
        const lang = (s.lang || '').toLowerCase();
        return (lang === 'ara' || lang === 'ar' || lang.startsWith('ar')) && s.url;
      })
      .map(s => {
        const rawUrl = (s.url || '').toLowerCase();
        const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
        const isAss = rawUrl.includes('.ass') || rawName.includes('.ass');
        const format = isAss ? 'ass' : 'srt';

        return {
          url: s.url,
          lang: 'ara',
          format: format,
          ext: format,
          fileName: s.SubFileName || s.title || s.name || 'OpenSubtitles Mirror',
          origName: s.SubFileName || s.title || s.name || 'OpenSubtitles Mirror',
          _source: 'opensubtitles',
          _priority: isAss ? 0 : 2
        };
      });
  } catch (e) {
    return [];
  }
}

async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const tasks = [];
  if (apiKey) {
    tasks.push(fetchOfficial(imdbId, season, episode, apiKey));
  }
  tasks.push(fetchMirror(imdbId, season, episode, type));

  const settled = await Promise.allSettled(tasks);
  return settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getOpenSubtitles };
