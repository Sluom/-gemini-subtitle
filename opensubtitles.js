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

    return data.map(item => {
      const attr = item.attributes || {};
      const file = (attr.files && attr.files[0]) || {};
      const lang = (attr.language || 'ara').toLowerCase();
      const isAr = lang.startsWith('ar');

      const realFileName = file.file_name || attr.release || '';
      const isAss = realFileName.toLowerCase().endsWith('.ass') || 
                    realFileName.toLowerCase().endsWith('.ssa') || 
                    (attr.format || '').toLowerCase() === 'ass';

      return {
        url: file.file_id ? `https://api.opensubtitles.com/api/v1/download/${file.file_id}` : attr.url,
        lang: isAr ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        ext: isAss ? 'ass' : 'srt',
        fileName: realFileName,
        origName: realFileName || 'OpenSubtitles Official',
        _source: 'opensubtitles-api',
        _priority: isAr ? (isAss ? 0 : 1) : 3
      };
    }).filter(s => s.url);
  } catch (e) {
    return [];
  }
}

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
      const isAss = (s.url || '').toLowerCase().includes('.ass') || (s.title || '').toLowerCase().includes('.ass');

      return {
        url: s.url,
        lang: isArabic ? 'ara' : 'eng',
        format: isAss ? 'ass' : 'srt',
        ext: isAss ? 'ass' : 'srt',
        fileName: s.title || s.name || '',
        origName: s.title || s.name || 'OpenSubtitles Mirror',
        _source: 'opensubtitles-mirror',
        _priority: isArabic ? (isAss ? 1 : 2) : 4
      };
    });
  } catch (e) {
    return [];
  }
}

async function getOpenSubtitles({ imdbId, season, episode, type, apiKey }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  if (apiKey) {
    const officialSubs = await fetchOpenSubtitlesOfficial(imdbId, season, episode, apiKey);
    if (officialSubs.length > 0) {
      return officialSubs;
    }
  }

  return await fetchOpenSubtitlesMirror(imdbId, season, episode, type);
}

module.exports = { getOpenSubtitles };
