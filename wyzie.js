const axios = require('axios');

const DEFAULT_KEY = 'zie-hf4qe3asclp38i3xhdbqdmqpgvxsvoav';

async function getWyzie({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const activeKey = (apiKey && apiKey.length > 10) ? apiKey.trim() : DEFAULT_KEY;

  // المصادر المسموحة رسمياً للمفتاح المجاني (Free-Verified) حتى لا يرفض السيرفر الطلب
  const sources = 'opensubtitles,indexsubtitle,tvsubtitles';
  
  let params = `id=${imdbId}&source=${sources}&key=${activeKey}`;
  if (season != null && episode != null) {
    params += `&season=${season}&episode=${episode}`;
  }
  // ويزي يعتمد كود ar للغة العربية
  params += `&language=ar`;

  try {
    const url = `https://sub.wyzie.io/search?${params}`;
    const res = await axios.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: 8000
    });

    if (!Array.isArray(res.data)) return [];

    return res.data.map(sub => {
      let dlUrl = sub.url || '';
      if (dlUrl && !dlUrl.startsWith('http')) {
        dlUrl = `https://sub.wyzie.io${dlUrl.startsWith('/') ? '' : '/'}${dlUrl}`;
      }

      const releaseName = sub.fileName || sub.releaseName || sub.release || 'Wyzie Sub';
      const lowerName = releaseName.toLowerCase();
      
      let format = 'srt';
      if (
        dlUrl.includes('format=ass') || dlUrl.includes('format=ssa') ||
        dlUrl.endsWith('.ass') || dlUrl.endsWith('.ssa') ||
        lowerName.endsWith('.ass') || lowerName.endsWith('.ssa') ||
        lowerName.includes('[ass]')
      ) {
        format = 'ass';
      }

      const sourceName = sub.source ? (Array.isArray(sub.source) ? sub.source[0] : sub.source) : 'wyzie';

      return {
        url: dlUrl,
        lang: 'ara',
        format: format,
        ext: format,
        subFormat: format,
        fileName: releaseName,
        origName: releaseName,
        _source: `wyzie-${sourceName}`,
        _isZip: dlUrl.endsWith('.zip'),
        _episode: episode || 1,
        _priority: format === 'ass' ? 0 : 2
      };
    }).filter(s => s.url);

  } catch (err) {
    return [];
  }
}

module.exports = { getWyzie };
