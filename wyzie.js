const axios = require('axios');

// دالة مبسطة ومستوحاة مباشرة من كود WyzieProvider الأصلي
async function getWyzie({ imdbId, season, episode, type, apiKey }) {
  if (!apiKey || apiKey.length < 10 || !imdbId || !imdbId.startsWith('tt')) {
    return [];
  }

  // المصادر اللي راح نجبر Wyzie يبحث بيها (بضمنها مصادر الأنمي القوية مثل animetosho و kitsunekko)
  const sources = 'opensubtitles,subf2m,animetosho,kitsunekko,gestdown,yify,tvsubtitles,indexsubtitle';
  
  // بناء رابط البحث حسب طريقة ويزي الرسمية
  let params = `id=${imdbId}&source=${sources}&key=${apiKey.trim()}`;
  if (season) params += `&season=${season}`;
  if (episode) params += `&episode=${episode}`;
  
  // فلترة اللغة للعربية لتقليل الضغط وتجنب النتائج العشوائية
  params += `&language=ara,ar`;

  try {
    const url = `https://sub.wyzie.io/search?${params}`;
    
    const res = await axios.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    });

    const results = res.data;
    if (!Array.isArray(results)) return [];

    // فلترة وتحويل النتائج لصيغة Nuvio اللي يفهمها index.js
    return results.map(sub => {
      let dlUrl = sub.url || '';
      let rawName = (sub.fileName || sub.releaseName || sub.release || 'Wyzie Sub').toLowerCase();
      let format = 'srt'; // الافتراضي

      // طريقة ويزي الأصلية لاكتشاف صيغ ASS/SSA من الرابط أو اسم الملف
      if (
        dlUrl.includes('format=ass') || dlUrl.includes('format=ssa') || 
        dlUrl.endsWith('.ass') || dlUrl.endsWith('.ssa') || 
        rawName.endsWith('.ass') || rawName.endsWith('.ssa') || 
        rawName.includes('[ass]')
      ) {
        format = 'ass';
      }

      // تحديد المصدر الحقيقي اللي جابته ويزي (مثلاً: wyzie-animetosho)
      const realSource = sub.source ? (Array.isArray(sub.source) ? sub.source[0] : sub.source) : 'unknown';

      return {
        url: dlUrl,
        lang: 'ara',
        format: format,
        ext: format,
        subFormat: format,
        fileName: sub.fileName || sub.releaseName || 'Wyzie Sub',
        origName: sub.fileName || sub.releaseName || 'Wyzie Sub',
        _source: `wyzie-${realSource}`,
        _isZip: dlUrl.endsWith('.zip'),
        _episode: episode || 1,
        _priority: format === 'ass' ? 0 : 2
      };
    }).filter(s => s.url); // نتأكد إن الرابط مو فارغ

  } catch (err) {
    // في حال فشل السيرفر أو المفتاح مخلص رصيده
    return [];
  }
}

module.exports = { getWyzie };

