const axios = require('axios');

function getAxiosConfig() {
  return {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    },
    timeout: 7500
  };
}

// سحب كافة الترجمات المتاحة من قاعدة بيانات OpenSubtitles المفتوحة
async function fetchFromMirror(imdbId, season, episode, type) {
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

  for (const s of subs) {
    const lang = (s.lang || '').toLowerCase();
    const isArabic = lang === 'ara' || lang === 'ar' || lang === 'arabic' || lang.startsWith('ar');

    // تصفية وحصر الترجمات باللغة العربية فقط
    if (!isArabic || !s.url) continue;

    const rawUrl = s.url.toLowerCase().split('?')[0];
    const rawName = (s.SubFileName || s.title || s.name || '').toLowerCase();
    const declaredFormat = (s.format || '').toLowerCase();

    // فحص دقيق للامتداد الحقيقي لتجنب تصفير الترجمات النصية
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
      origName: s.SubFileName || s.title || s.name || 'OpenSubtitles',
      _source: 'opensubtitles',
      _priority: detectedFormat === 'ass' ? 0 : 1
    });
  }

  return results;
}

// دالة احتياطية في حال كان العمل حديثاً جداً وغير مفهرس بعد
async function fetchFromOfficialFallback(imdbId, season, episode, apiKey) {
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
    const res = await axios.get(url, {
      headers: {
        'Api-Key': apiKey.trim(),
        'User-Agent': 'NuvioSubtitles v1.0.0',
        'Accept': 'application/json'
      },
      timeout: 6000
    });

    const data = res.data?.data || [];
    const results = [];

    for (const item of data) {
      const attr = item.attributes || {};
      const files = attr.files || [];
      const lang = (attr.language || '').toLowerCase();
      if (!lang.startsWith('ar') && lang !== 'ara') continue;

      for (const file of files) {
        if (!file.file_id) continue;
        const fileName = (file.file_name || attr.release || '').toLowerCase();
        const isAss = fileName.endsWith('.ass') || fileName.endsWith('.ssa') || (attr.format || '').toLowerCase() === 'ass';
        const format = isAss ? 'ass' : 'srt';

        try {
          const dlRes = await axios.post(
            'https://api.opensubtitles.com/api/v1/download',
            { file_id: file.file_id },
            {
              headers: {
                'Api-Key': apiKey.trim(),
                'Content-Type': 'application/json'
              },
              timeout: 4000
            }
          );

          if (dlRes.data?.link) {
            results.push({
              url: dlRes.data.link,
              lang: 'ara',
              format: format,
              ext: format,
              fileName: file.file_name || attr.release || '',
              origName: file.file_name || attr.release || 'OpenSubtitles Official',
              _source: 'opensubtitles',
              _priority: isAss ? 0 : 1
            });
          }
        } catch (err) {
          // استمرار السحب في حال تعثر ملف فردي
        }
      }
    }

    return results;
  } catch (e) {
    return [];
  }
}

async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  try {
    // 1. السحب الأساسي الشامل لجميع الترجمات العربية دون لمت
    const subs = await fetchFromMirror(imdbId, season, episode, type);
    if (subs.length > 0) {
      return subs;
    }

    // 2. التحويل للاحتياطي الرسمي فقط إذا كانت النتيجة فارغة وتوفر مفتاح API
    if (apiKey) {
      return await fetchFromOfficialFallback(imdbId, season, episode, apiKey);
    }

    return [];
  } catch (err) {
    // في حال تعثر السيرفر الأول وكان المفتاح متوفراً
    if (apiKey) {
      return await fetchFromOfficialFallback(imdbId, season, episode, apiKey);
    }
    return [];
  }
}

module.exports = { getOpenSubtitles };
