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

// فحص دقيق وشامل لصيغ SSA و ASS
function checkIsAss(file, attr) {
  const fileName = (file?.file_name || '').toLowerCase();
  const release = (attr?.release || '').toLowerCase();
  const format = (attr?.format || file?.format || '').toLowerCase();
  const subFormat = (attr?.sub_format || file?.sub_format || '').toLowerCase();

  return (
    format === 'ass' ||
    format === 'ssa' ||
    subFormat === 'ass' ||
    subFormat === 'ssa' ||
    fileName.endsWith('.ass') ||
    fileName.endsWith('.ssa') ||
    fileName.includes('.ass') ||
    fileName.includes('.ssa') ||
    release.includes('.ass') ||
    release.includes('.ssa') ||
    release.includes('[ass]') ||
    release.includes('[ssa]')
  );
}

async function searchOpenSubtitlesApi(paramsObj, apiKey) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(paramsObj)) {
    if (value != null && value !== '') {
      params.set(key, String(value));
    }
  }

  const url = `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`;
  const res = await axios.get(url, getAxiosConfig(apiKey));
  return Array.isArray(res.data?.data) ? res.data.data : [];
}

// 1. السحب عبر الـ API الرسمي
async function fetchOfficial(imdbId, season, episode, type, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  const cleanNumericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
  const isSeries = type === 'series' || season != null;

  let items = [];

  try {
    if (isSeries && season != null && episode != null) {
      items = await searchOpenSubtitlesApi({
        parent_imdb_id: cleanNumericId,
        season_number: season,
        episode_number: episode,
        languages: 'ar'
      }, apiKey);

      if (!items.length) {
        items = await searchOpenSubtitlesApi({
          imdb_id: cleanNumericId,
          season_number: season,
          episode_number: episode,
          languages: 'ar'
        }, apiKey);
      }
    } else {
      items = await searchOpenSubtitlesApi({
        imdb_id: cleanNumericId,
        languages: 'ar'
      }, apiKey);
    }
  } catch (err) {
    items = [];
  }

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
        subFormat: isAss ? 'ssa' : 'srt',
        fileName: rawName,
        origName: rawName,
        _source: 'opensubtitles',
        _priority: isAss ? 0 : 1
      });
    });
  });

  return results;
}

// 2. السحب عبر سيرفر Stremio (سيرفر SubSense الأساسي لصيد الـ SSA)
async function fetchMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const isSeries = type === 'series' || !!season;
    const mediaType = isSeries ? 'series' : 'movie';
    const targetId = isSeries && season ? `${imdbId}:${season}:${episode || 1}` : imdbId;

    const url = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`;
    const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 7000 });
    const list = res.data?.subtitles || [];

    return list
      .filter(s => {
        const lang = (s.lang || '').toLowerCase();
        return (lang === 'ara' || lang === 'ar' || lang.startsWith('ar')) && s.url;
      })
      .map(s => {
        const rawUrl = (s.url || '').toLowerCase();
        const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
        const subFormat = (s.SubFormat || s.format || s.subFormat || '').toLowerCase();

        // صيد صيغة SSA المعتمدة بسيرفر OpenSubtitles
        const isAss = subFormat === 'ssa' ||
                      subFormat === 'ass' ||
                      rawUrl.includes('.ass') ||
                      rawUrl.includes('.ssa') ||
                      rawName.includes('.ass') ||
                      rawName.includes('.ssa');

        const format = isAss ? 'ass' : 'srt';

        return {
          url: s.url,
          lang: 'ara',
          format: format,
          ext: format,
          subFormat: isAss ? 'ssa' : 'srt',
          SubFormat: isAss ? 'ssa' : 'srt',
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
    tasks.push(fetchOfficial(imdbId, season, episode, type, apiKey));
  }
  tasks.push(fetchMirror(imdbId, season, episode, type));

  const settled = await Promise.allSettled(tasks);
  return settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getOpenSubtitles };
