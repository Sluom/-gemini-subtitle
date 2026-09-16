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

// فحص دقيق وشامل لملفات الـ ASS و SSA
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

// دالة تنفيذ طلب البحث في API OpenSubtitles الرسمي
async function searchOpenSubtitlesApi(paramsObj, apiKey) {
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(paramsObj)) {
      if (value != null && value !== '') {
        params.set(key, String(value));
      }
    }

    const url = `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`;
    const res = await axios.get(url, getAxiosConfig(apiKey));
    return Array.isArray(res.data?.data) ? res.data.data : [];
  } catch (err) {
    return [];
  }
}

// السحب عبر الـ API الرسمي بالمفتاح
async function fetchOfficial(imdbId, season, episode, type, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  const cleanNumericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
  const isEpisodic = episode != null || season != null || type === 'series' || type === 'anime';

  const baseParams = {
    languages: 'ar,ara'
  };

  if (isEpisodic) {
    baseParams.parent_imdb_id = cleanNumericId;
    if (season != null) baseParams.season_number = season;
    if (episode != null) baseParams.episode_number = episode;
  } else {
    baseParams.imdb_id = cleanNumericId;
  }

  // نطلب ملفات ASS/SSA بطلب مخصص وملفات SRT بطلب مخصص لضمان عدم ضياعها بسبب الترقيم
  let [assItems, srtItems] = await Promise.all([
    searchOpenSubtitlesApi({ ...baseParams, formats: 'ass,ssa' }, apiKey),
    searchOpenSubtitlesApi({ ...baseParams, formats: 'srt' }, apiKey)
  ]);

  // فحص احتياطي برقم imdb_id المباشر في حال لم ترجع نتائج بـ parent_imdb_id
  if (!assItems.length && !srtItems.length && isEpisodic) {
    const fallbackParams = {
      imdb_id: cleanNumericId,
      languages: 'ar,ara'
    };
    if (season != null) fallbackParams.season_number = season;
    if (episode != null) fallbackParams.episode_number = episode;

    const [fbAss, fbSrt] = await Promise.all([
      searchOpenSubtitlesApi({ ...fallbackParams, formats: 'ass,ssa' }, apiKey),
      searchOpenSubtitlesApi({ ...fallbackParams, formats: 'srt' }, apiKey)
    ]);
    assItems = fbAss;
    srtItems = fbSrt;
  }

  const allRawItems = [...assItems, ...srtItems];
  const results = [];

  allRawItems.forEach(item => {
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

// السحب الاحتياطي عبر سيرفر Stremio
async function fetchMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const isSeries = type === 'series' || type === 'anime' || !!season;
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
