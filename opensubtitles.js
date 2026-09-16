const axios = require('axios');

function getAxiosConfig(extraHeaders = {}) {
  return {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      ...extraHeaders
    },
    timeout: 7000
  };
}

// 1. سحب شكو ترجمة عربية مسجلة بالـ API الرسمي دفعة واحدة
async function fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey) {
  if (!apiKey || !imdbId || !imdbId.startsWith('tt')) return [];

  const numericImdb = imdbId.replace('tt', '');
  const params = new URLSearchParams({
    imdb_id: numericImdb,
    languages: 'ar,ara'
  });

  if (season) params.set('season_number', String(season));
  if (episode) params.set('episode_number', String(episode));

  try {
    const url = `https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`;
    const res = await axios.get(url, getAxiosConfig({ 'Api-Key': apiKey.trim() }));
    const data = res.data?.data || [];

    const results = [];

    data.forEach(item => {
      const attr = item.attributes || {};
      const files = attr.files || [];
      const lang = (attr.language || '').toLowerCase();
      const isArabic = lang.startsWith('ar') || lang === 'ara' || lang === 'arabic';

      if (!isArabic) return;

      files.forEach(file => {
        if (!file.file_id) return;

        const rawName = (file.file_name || attr.release || '').toLowerCase();
        let detectedFormat = 'srt';

        if (rawName.endsWith('.ass') || rawName.endsWith('.ssa') || (attr.format || '').toLowerCase() === 'ass') {
          detectedFormat = 'ass';
        } else if (rawName.endsWith('.vtt') || (attr.format || '').toLowerCase() === 'vtt') {
          detectedFormat = 'vtt';
        }

        // تحويل الرابط إلى مسار داخلي مثل SubSense تماماً لمنع الحظر
        results.push({
          url: `os://${file.file_id}?format=${detectedFormat}&name=${encodeURIComponent(file.file_name || '')}`,
          lang: 'ara',
          format: detectedFormat,
          ext: detectedFormat,
          fileName: file.file_name || attr.release || '',
          origName: file.file_name || attr.release || 'OpenSubtitles Official',
          _source: 'opensubtitles',
          _priority: detectedFormat === 'ass' ? 0 : 1
        });
      });
    });

    return results;
  } catch (e) {
    return [];
  }
}

// 2. سحب ترجمات الميرور العام
async function fetchOpenSubtitlesMirror(imdbId, season, episode, type) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];
  try {
    let mediaType = 'movie';
    let targetId = imdbId;

    if (season || type === 'series') {
      mediaType = 'series';
      targetId = `${imdbId}:${season || 1}:${episode || 1}`;
    }

    const url = `https://opensubtitles-v3.strem.io/subtitles/${mediaType}/${targetId}.json`;
    const res = await axios.get(url, getAxiosConfig());
    const subs = res.data?.subtitles || [];

    const results = [];

    subs.forEach(s => {
      const lang = (s.lang || '').toLowerCase();
      const isArabic = lang === 'ara' || lang === 'ar' || lang === 'arabic' || lang.startsWith('ar');

      if (!isArabic || !s.url) return;

      const rawUrl = s.url.toLowerCase().split('?')[0];
      const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
      const declaredFormat = (s.format || '').toLowerCase();

      let detectedFormat = 'srt';
      if (
        declaredFormat === 'ass' || 
        declaredFormat === 'ssa' ||
        rawUrl.endsWith('.ass') || 
        rawUrl.endsWith('.ssa') ||
        rawName.endsWith('.ass') || 
        rawName.endsWith('.ssa')
      ) {
        detectedFormat = 'ass';
      } else if (
        declaredFormat === 'vtt' || 
        rawUrl.endsWith('.vtt') || 
        rawName.endsWith('.vtt')
      ) {
        detectedFormat = 'vtt';
      }

      results.push({
        url: s.url,
        lang: 'ara',
        format: detectedFormat,
        ext: detectedFormat,
        fileName: s.SubFileName || s.title || s.name || `OpenSubtitles Arabic ${detectedFormat.toUpperCase()}`,
        origName: s.SubFileName || s.title || s.name || 'OpenSubtitles Mirror',
        _source: 'opensubtitles',
        _priority: detectedFormat === 'ass' ? 0 : 1
      });
    });

    return results;
  } catch (e) {
    return [];
  }
}

// 3. دمج المصدرين سوية بالتوازي بدون لمت
async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const tasks = [
    fetchOpenSubtitlesMirror(imdbId, season, episode, type)
  ];

  if (apiKey) {
    tasks.push(fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey));
  }

  const results = await Promise.allSettled(tasks);

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(s => s && s.url);
}

module.exports = { getOpenSubtitles };
