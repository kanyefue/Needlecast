'use strict';

const USER_AGENT = 'Needlecast/0.5.0 (open-source desktop application)';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function normalizeForMatch(value) {
  return clean(value, 500)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function asHttps(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLocaleLowerCase();
    const allowed = host === 'mzstatic.com' || host.endsWith('.mzstatic.com')
      || host === 'apple.com' || host.endsWith('.apple.com')
      || host === 'discogs.com' || host.endsWith('.discogs.com');
    return allowed ? url.href : '';
  } catch (_) {
    return '';
  }
}

function artworkSizes(url) {
  const secure = asHttps(url);
  if (!secure) return { thumb: '', coverImage: '' };
  // Apple Search API commonly returns artworkUrl100. Request larger variants for
  // the album detail panel while retaining a smaller version for the grid.
  const coverImage = secure.replace(/100x100(?:bb|-\d+)?/gi, '600x600bb')
    .replace(/\b100x100\b/gi, '600x600');
  const thumb = secure.replace(/100x100(?:bb|-\d+)?/gi, '250x250bb')
    .replace(/\b100x100\b/gi, '250x250');
  return { thumb, coverImage };
}

function scoreAppleResult(row, title, artist, year) {
  const candidateTitle = normalizeForMatch(row.collectionName || row.trackName || '');
  const candidateArtist = normalizeForMatch(row.artistName || '');
  const wantedTitle = normalizeForMatch(title);
  const wantedArtist = normalizeForMatch(artist);
  if (!candidateTitle || !row.artworkUrl100) return -1;

  let score = 0;
  if (candidateTitle === wantedTitle) score += 8;
  else if (candidateTitle.startsWith(`${wantedTitle} `) || wantedTitle.startsWith(`${candidateTitle} `)) score += 5;
  else if (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle)) score += 3;
  else return -1;

  if (wantedArtist) {
    if (candidateArtist === wantedArtist) score += 6;
    else if (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist)) score += 3;
    else score -= 3;
  }
  if (year && /^\d{4}/.test(String(row.releaseDate || '')) && String(row.releaseDate).slice(0, 4) === String(year)) score += 1;
  return score;
}

class AlbumArtworkService {
  constructor({ fetchImpl = fetch, discogsService = null, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.discogsService = discogsService;
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async requestJson(url, service) {
    const response = await this.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`${service} artwork lookup failed (HTTP ${response.status}).`);
    }
    return response.json();
  }

  async findArtwork({ title, artist = '', year = '', discogsId = null } = {}) {
    title = clean(title);
    artist = clean(artist);
    year = clean(year, 4);
    discogsId = /^\d{1,12}$/.test(String(discogsId || '')) ? String(discogsId) : '';
    if (!title) throw new Error('An album title is required for artwork lookup.');

    const key = `${discogsId}\u0000${normalizeForMatch(artist)}\u0000${normalizeForMatch(title)}\u0000${year}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < (cached.result.matched ? CACHE_TTL_MS : MISS_TTL_MS)) {
      return { ...cached.result, cached: true };
    }
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const pending = this.lookup({ title, artist, year, discogsId })
      .then((result) => {
        if (!result.retryable) this.cache.set(key, { at: this.now(), result });
        const output = { ...result, cached: false };
        delete output.retryable;
        return output;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  async lookup({ title, artist, year, discogsId }) {
    // An exact Discogs release ID is the best match for a physical pressing.
    if (discogsId && this.discogsService?.configured) {
      try {
        const response = await this.discogsService.getRelease(discogsId);
        const release = response?.release || {};
        const coverImage = asHttps(release.coverImage || release.thumb);
        const thumb = asHttps(release.thumb || release.coverImage);
        if (coverImage || thumb) {
          return {
            matched: true,
            coverImage: coverImage || thumb,
            thumb: thumb || coverImage,
            artworkProvider: 'Discogs',
            artworkMatch: 'release-id',
          };
        }
      } catch (_) {
        // An unavailable Discogs lookup must not prevent the Apple fallback.
      }
    }

    const term = [artist, title].filter(Boolean).join(' ').slice(0, 250);
    const params = new URLSearchParams({ term, entity: 'album', media: 'music', limit: '25', country: 'US' });
    let data;
    try {
      data = await this.requestJson(`https://itunes.apple.com/search?${params.toString()}`, 'Apple Music Search');
    } catch (_) {
      // Do not cache a transient network/API failure as a genuine no-artwork match.
      return { matched: false, coverImage: '', thumb: '', artworkProvider: '', artworkMatch: '', retryable: true };
    }
    try {
      const results = Array.isArray(data?.results) ? data.results : [];
      const ranked = results
        .map((row) => ({ row, score: scoreAppleResult(row, title, artist, year) }))
        .sort((a, b) => b.score - a.score);
      const best = ranked.find((entry) => entry.score >= (artist ? 7 : 6));
      if (best) {
        const urls = artworkSizes(best.row.artworkUrl100);
        if (urls.thumb || urls.coverImage) {
          return {
            matched: true,
            coverImage: urls.coverImage || urls.thumb,
            thumb: urls.thumb || urls.coverImage,
            artworkProvider: 'Apple Music Search',
            artworkMatch: 'album-and-artist',
            matchedTitle: clean(best.row.collectionName || ''),
            matchedArtist: clean(best.row.artistName || ''),
            artworkUrl: asHttps(best.row.collectionViewUrl || ''),
          };
        }
      }
    } catch (_) {
      // Malformed responses are treated as a transient failure and retried later.
      return { matched: false, coverImage: '', thumb: '', artworkProvider: '', artworkMatch: '', retryable: true };
    }

    return { matched: false, coverImage: '', thumb: '', artworkProvider: '', artworkMatch: '' };
  }
}

module.exports = { AlbumArtworkService, normalizeForMatch, artworkSizes, scoreAppleResult };
