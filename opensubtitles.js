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
    format === 'ass' || format === 'ssa' ||
    subFormat === 'ass' || subFormat === 'ssa' ||
    fileName.endsWith('.ass') || fileName.endsWith('.ssa') ||
    fileName.includes('.ass') || fileName.includes('.ssa') ||
    release.includes('.ass') || release.includes('.ssa') ||
    release.includes('[ass]') || release.includes('[ssa]')
  );
}

// السحب عبر الـ API الرسمي (الجديد)
async function fetchOfficial(imdbId, season, episode, type, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  try {
    const cleanNumericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
    const isEpisodic = episode != null || season != null || type === 'series' || type === 'anime';
    const params = new URLSearchParams({ languages: 'ar,ara' });

    if (isEpisodic) {
      params.set('parent_imdb_id', cleanNumericId);
      if (season != null) params.set('season_number', season);
      if (episode != null) params.set('episode_number', episode);
    } else {
      params.set('imdb_id', cleanNumericId);
    }

    const res = await axios.get(`https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`, getAxiosConfig(apiKey));
    const allRawItems = Array.isArray(res.data?.data) ? res.data.data : [];
    
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
  } catch (err) {
    return [];
  }
}

// دالة داخلية لجلب بيانات السيرفر القديم بدون تخريب الروابط
async function fetchLegacyData(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'VLSub 0.10.3', 
        'X-User-Agent': 'VLSub 0.10.3',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];

    const results = [];
    data.forEach(entry => {
      const downloadLink = entry.SubDownloadLink;
      if (!downloadLink) return;

      const format = (entry.SubFormat || '').toLowerCase();
      const rawName = entry.SubFileName || entry.MovieReleaseName || 'OpenSubtitles Legacy';
      const isAss = format === 'ass' || format === 'ssa' || rawName.toLowerCase().includes('.ass') || rawName.toLowerCase().includes('.ssa');
      const finalExt = isAss ? 'ass' : 'srt';

      // الرابط يرسل كما هو (حتى لو انتهى بـ .gz) لأن الـ index.js سيفك الضغط بذكاء
      results.push({
        url: downloadLink,
        lang: 'ara',
        format: finalExt,
        ext: finalExt,
        subFormat: isAss ? 'ssa' : 'srt',
        fileName: rawName,
        origName: rawName,
        _source: 'opensubtitles',
        _priority: isAss ? 0 : 2
      });
    });
    return results;
  } catch (e) {
    return [];
  }
}

// السحب عبر الـ API القديم
async function fetchLegacyApi(imdbId, season, episode) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  const numericId = imdbId.replace(/^tt/, '').replace(/^0+/, '');
  
  let primaryUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;
  if (season != null && episode != null) {
    primaryUrl = `https://rest.opensubtitles.org/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`;
  }

  let results = await fetchLegacyData(primaryUrl);

  if (results.length === 0 && season != null) {
    const fallbackUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-ara`;
    results = await fetchLegacyData(fallbackUrl);
  }

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

        const isAss = subFormat === 'ssa' || subFormat === 'ass' || rawUrl.includes('.ass') || rawUrl.includes('.ssa') || rawName.includes('.ass') || rawName.includes('.ssa');
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
  if (apiKey) tasks.push(fetchOfficial(imdbId, season, episode, type, apiKey));
  tasks.push(fetchLegacyApi(imdbId, season, episode));
  tasks.push(fetchMirror(imdbId, season, episode, type));

  const settled = await Promise.allSettled(tasks);
  const allSubs = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);

  // نظام فلترة وتصفية صارم لمنع تكرار نفس الترجمة من السيرفرات الثلاثة
  const uniqueSubs = [];
  const seenIds = new Set();

  for (const sub of allSubs) {
    let fileId = sub.url;
    // استخراج المعرف الرقمي الصافي للترجمة سواء كان من API جديد أو قديم
    const osMatch = sub.url.match(/os:\/\/(\d+)/);
    const dlMatch = sub.url.match(/\/file\/(\d+)/);
    
    if (osMatch) fileId = osMatch[1];
    else if (dlMatch) fileId = dlMatch[1];

    if (seenIds.has(fileId)) continue;
    
    seenIds.add(fileId);
    uniqueSubs.push(sub);
  }

  // إرجاع كافة الترجمات الفعالة بدون أي قيود أو قطع للعدد
  return uniqueSubs;
}

module.exports = { getOpenSubtitles };
