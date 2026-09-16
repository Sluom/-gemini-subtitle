const axios = require('axios');

const BASE_URL = 'https://rest.opensubtitles.org';
const USER_AGENT = 'VLSub 0.10.3';
const TIMEOUT = 10000;

function buildDownloadUrl(rawUrl, format = 'srt') {
  if (!rawUrl) return null;
  return rawUrl.replace(/\.gz$/, '') + '.' + format;
}

async function getOpenSubtitles({ imdbId, season, episode }) {
  if (!imdbId || !imdbId.startsWith('tt')) return [];

  const numericId = imdbId.replace(/^tt/, '');
  let searchPath = `/search/imdbid-${numericId}/sublanguageid-ara`;

  if (season != null && episode != null) {
    searchPath = `/search/episode-${episode}/imdbid-${numericId}/season-${season}/sublanguageid-ara`;
  }

  const url = `${BASE_URL}${searchPath}`;

  try {
    const res = await axios.get(url, {
      headers: {
        'X-User-Agent': USER_AGENT,
        'Accept': 'application/json'
      },
      timeout: TIMEOUT
    });

    const data = res.data;
    if (!Array.isArray(data)) return [];

    const results = [];
    const seenIds = new Set();

    for (const entry of data) {
      const id = entry.IDSubtitleFile;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const fmt = (entry.SubFormat || 'srt').toLowerCase();
      const directDownloadUrl = buildDownloadUrl(entry.SubDownloadLink, fmt);

      if (!directDownloadUrl) continue;

      const isAss = fmt === 'ass' || fmt === 'ssa';

      results.push({
        url: directDownloadUrl,
        lang: 'ara',
        format: isAss ? 'ass' : (fmt === 'vtt' ? 'vtt' : 'srt'),
        ext: isAss ? 'ass' : (fmt === 'vtt' ? 'vtt' : 'srt'),
        fileName: entry.SubFileName || entry.MovieReleaseName || `OpenSubtitles Arabic ${fmt.toUpperCase()}`,
        origName: entry.MovieReleaseName || entry.SubFileName || 'OpenSubtitles',
        _source: 'opensubtitles',
        _priority: isAss ? 0 : 1
      });
    }

    return results;
  } catch (err) {
    return [];
  }
}

module.exports = { getOpenSubtitles };
