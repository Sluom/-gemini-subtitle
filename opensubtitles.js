const axios = require('axios');

function getAxiosConfig(extraHeaders = {}) {
  return {
    headers: {
      'User-Agent': 'NuvioSubtitles v1.0.0',
      'Accept': 'application/json',
      ...extraHeaders
    },
    timeout: 8000
  };
}

// جلب رابط التحميل المباشر والنهائي للملف من الـ API الرسمي
async function resolveDownloadLink(fileId, apiKey) {
  if (!fileId || !apiKey) return null;
  try {
    const res = await axios.post(
      'https://api.opensubtitles.com/api/v1/download',
      { file_id: fileId },
      getAxiosConfig({
        'Api-Key': apiKey.trim(),
        'Content-Type': 'application/json'
      })
    );
    return res.data?.link || null;
  } catch (e) {
    return null;
  }
}

// السحب من الـ API الرسمي لـ OpenSubtitles
async function fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  const numericImdb = imdbId.replace('tt', '');
  const params = new URLSearchParams({
    imdb_id: numericImdb,
    languages: 'ar,en'
  });

  if (season) params.set('season_number', String(season));
  if (episode) params.set('episode_number', String(episode));

  try {
    const url = `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`;
    const res = await axios.get(url, getAxiosConfig({ 'Api-Key': apiKey.trim() }));
    const data = res.data?.data || [];

    const candidates = [];

    data.forEach(item => {
      const attr = item.attributes || {};
      const files = attr.files || [];
      const lang = (attr.language || 'ara').toLowerCase();
      const isAr = lang.startsWith('ar');

      files.forEach(file => {
        const rawName = (file.file_name || attr.release || '').toLowerCase();
        let detectedFormat = 'srt';

        if (rawName.endsWith('.ass') || rawName.endsWith('.ssa') || (attr.format || '').toLowerCase() === 'ass') {
          detectedFormat = 'ass';
        } else if (rawName.endsWith('.vtt') || (attr.format || '').toLowerCase() === 'vtt') {
          detectedFormat = 'vtt';
        }

        if (file.file_id) {
          candidates.push({
            fileId: file.file_id,
            lang: isAr ? 'ara' : 'eng',
            format: detectedFormat,
            ext: detectedFormat,
            fileName: file.file_name || attr.release || '',
            origName: file.file_name || attr.release || 'OpenSubtitles Official',
            _source: 'opensubtitles',
            _priority: isAr ? (detectedFormat === 'ass' ? 0 : 1) : 3
          });
        }
      });
    });

    // تحويل الترجمات لروابط تحميل مباشرة بالتوازي
    const resolvedSubs = await Promise.allSettled(
      candidates.map(async item => {
        const directUrl = await resolveDownloadLink(item.fileId, apiKey);
        if (!directUrl) return null;
        return {
          url: directUrl,
          lang: item.lang,
          format: item.format,
          ext: item.ext,
          fileName: item.fileName,
          origName: item.origName,
          _source: item._source,
          _priority: item._priority
        };
      })
    );

    return resolvedSubs
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

  } catch (e) {
    return [];
  }
}

// السحب من سيرفر الـ Mirror العام
async function fetchOpenSubtitlesMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    const mediaType = season ? 'series' : (type === 'series' ? 'series' : 'movie');
    const targetId = season ? `${imdbId}:${season}:${episode || 1}` : imdbId;
    const res = await axios.get(
      `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`,
      getAxiosConfig()
    );

    const subs = res.data?.subtitles || [];
    return subs.map(s => {
      const isArabic = (s.lang || 'ara').toLowerCase().startsWith('ar');
      const checkText = `${s.url || ''} ${s.title || ''} ${s.name || ''}`.toLowerCase();
      const isAss = checkText.includes('.ass') || checkText.includes('.ssa');

      return {
        url: s.url,
        lang: isArabic ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        ext: isAss ? 'ass' : 'srt',
        fileName: s.title || s.name || '',
        origName: s.title || s.name || 'OpenSubtitles Mirror',
        _source: 'opensubtitles',
        _priority: isArabic ? (isAss ? 0 : 1) : 3
      };
    }).filter(s => s.url);
  } catch (e) {
    return [];
  }
}

// الدالة الرئيسية المستدعاة بملف index.js
async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const tasks = [
    fetchOpenSubtitlesMirror(imdbId, season, episode, type)
  ];

  if (apiKey) {
    tasks.unshift(fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey));
  }

  const results = await Promise.allSettled(tasks);
  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);

  // منع تكرار الروابط المتطابقة
  const seen = new Set();
  return all.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

module.exports = { getOpenSubtitles };
