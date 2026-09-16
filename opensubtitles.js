const axios = require('axios');

function getAxiosConfig(extraHeaders = {}) {
  return {
    headers: {
      'User-Agent': 'NuvioSubtitles v1.0.0',
      'Accept': 'application/json',
      ...extraHeaders
    },
    timeout: 9000
  };
}

// طلب رابط التحميل الفعلي من الـ API الرسمي
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

// سحب شكو ترجمة عربية من الـ API الرسمي
async function fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  const numericImdb = imdbId.replace('tt', '');
  const params = new URLSearchParams({
    imdb_id: numericImdb,
    languages: 'ar,ara' // عربي حصراً حتى ما تضيع النتائج بالإنكليزي
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
      const lang = (attr.language || '').toLowerCase();
      const isArabic = lang.startsWith('ar') || lang === 'ara' || lang === 'arabic';

      // استبعاد أي لغة غير العربي
      if (!isArabic) return;

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
            lang: 'ara',
            format: detectedFormat,
            ext: detectedFormat,
            fileName: file.file_name || attr.release || '',
            origName: file.file_name || attr.release || 'OpenSubtitles Official',
            _source: 'opensubtitles',
            _priority: detectedFormat === 'ass' ? 0 : 1
          });
        }
      });
    });

    // جلب الروابط بالتوازي
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

// سحب شكو ترجمة عربية من سيرفر الـ Mirror العام
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
    const results = [];

    subs.forEach(s => {
      const lang = (s.lang || '').toLowerCase();
      const isArabic = lang.startsWith('ar') || lang === 'ara' || lang === 'arabic';

      // عربي حصراً
      if (!isArabic) return;

      const checkText = `${s.url || ''} ${s.title || ''} ${s.name || ''}`.toLowerCase();
      const isAss = checkText.includes('.ass') || checkText.includes('.ssa');

      results.push({
        url: s.url,
        lang: 'ara',
        format: isAss ? 'ass' : 'srt',
        ext: isAss ? 'ass' : 'srt',
        fileName: s.title || s.name || '',
        origName: s.title || s.name || 'OpenSubtitles Mirror',
        _source: 'opensubtitles',
        _priority: isAss ? 0 : 1
      });
    });

    return results;
  } catch (e) {
    return [];
  }
}

// جلب ودمج كل النتائج بدون حذف أي تكرار
async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const tasks = [
    fetchOpenSubtitlesMirror(imdbId, season, episode, type)
  ];

  if (apiKey) {
    tasks.unshift(fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey));
  }

  const results = await Promise.allSettled(tasks);
  
  // دمج مباشر لكل شي رجع بدون أي فلترة أو Set لمنع التكرار
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getOpenSubtitles };
