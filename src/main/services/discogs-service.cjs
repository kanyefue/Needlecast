'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COLLECTION_TTL_MS = 10 * 60 * 1000;
const RELEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'Needlecast/0.3.0 (open-source desktop application)';

function normalizeCollectionEntry(entry) {
  const info = entry?.basic_information || {};
  const artists = Array.isArray(info.artists) ? info.artists.map((artist) => artist.name).filter(Boolean) : [];
  const formats = Array.isArray(info.formats)
    ? info.formats.map((format) => [format.name, ...(format.descriptions || [])].filter(Boolean).join(' · '))
    : [];
  return {
    id: Number(info.id || entry.id || 0),
    instanceId: Number(entry.instance_id || 0),
    title: String(info.title || 'Untitled release'),
    artists,
    artistText: artists.join(', ') || 'Unknown artist',
    year: info.year ? String(info.year) : '',
    thumb: String(info.thumb || ''),
    coverImage: String(info.cover_image || info.thumb || ''),
    formats: [...new Set(formats)],
    labels: Array.isArray(info.labels) ? info.labels.map((label) => label.name).filter(Boolean) : [],
    dateAdded: entry.date_added || null,
  };
}

function normalizeReleaseDetail(release) {
  return {
    id: Number(release.id),
    title: String(release.title || 'Untitled release'),
    artists: Array.isArray(release.artists) ? release.artists.map((artist) => artist.name).filter(Boolean) : [],
    year: release.year ? String(release.year) : '',
    thumb: String(release.thumb || ''),
    coverImage: String(release.images?.find((image) => image.type === 'primary')?.uri || release.images?.[0]?.uri || release.thumb || ''),
    labels: Array.isArray(release.labels) ? release.labels.map((label) => label.name).filter(Boolean) : [],
    uri: String(release.uri || ''),
  };
}

class DiscogsService {
  constructor({ username = '', token = '', dataDir } = {}) {
    this.username = username;
    this.token = token;
    const userKey = crypto.createHash('sha256').update(this.username.toLocaleLowerCase()).digest('hex').slice(0, 12);
    this.cacheFile = path.join(dataDir || path.join(process.cwd(), '.needlecast-data'), `discogs-cache-${userKey}.json`);
    this.cache = this.loadCache();
  }

  get configured() {
    return Boolean(this.username && this.token);
  }

  loadCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return {
        collection: parsed.collection || null,
        releases: parsed.releases && typeof parsed.releases === 'object' ? parsed.releases : {},
        selection: parsed.selection || null,
      };
    } catch (_) {
      return { collection: null, releases: {}, selection: null };
    }
  }

  persistCache() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const temp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.cache), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.cacheFile);
    } catch (error) {
      // A cache write failure should not stop collection browsing; it only disables persistence.
      console.warn(`Could not persist Discogs cache: ${error.message}`);
    }
  }

  async get(url) {
    if (!this.configured) {
      const error = new Error('Connect Discogs in Settings before browsing your collection.');
      error.statusCode = 400;
      throw error;
    }
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Authorization': `Discogs token=${this.token}`,
        'Accept': 'application/vnd.discogs.v2.discogs+json',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      let message = `Discogs API request failed (HTTP ${response.status}).`;
      let statusCode = 502;
      if (response.status === 401 || response.status === 403) {
        message = 'Discogs rejected the token. Recheck your username and personal access token in Settings.';
        statusCode = 401;
      } else if (response.status === 429) {
        message = 'Discogs rate limit reached. Wait a little, then refresh the collection.';
        statusCode = 429;
      } else if (response.status === 404) {
        message = 'Discogs could not find this user or release.';
        statusCode = 404;
      }
      const error = new Error(message);
      error.statusCode = statusCode;
      throw error;
    }
    return response.json();
  }

  async getCollection(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cache.collection && now - this.cache.collection.cachedAt < COLLECTION_TTL_MS) {
      return this.cache.collection;
    }
    const releases = [];
    let page = 1;
    let pages = 1;
    do {
      const url = `https://api.discogs.com/users/${encodeURIComponent(this.username)}/collection/folders/0/releases?per_page=100&page=${page}`;
      const result = await this.get(url);
      const rows = Array.isArray(result.releases) ? result.releases : [];
      releases.push(...rows.map(normalizeCollectionEntry));
      pages = Math.max(1, Number(result.pagination?.pages || 1));
      page += 1;
      if (page > 500) throw new Error('Discogs reported an unexpectedly large collection. Please report this issue.');
    } while (page <= pages);
    this.cache.collection = { cachedAt: now, releases };
    this.persistCache();
    return this.cache.collection;
  }

  async getRelease(releaseId) {
    const now = Date.now();
    const cached = this.cache.releases[releaseId];
    if (cached && now - cached.cachedAt < RELEASE_TTL_MS) return { release: cached.release, cached: true };
    const raw = await this.get(`https://api.discogs.com/releases/${releaseId}`);
    const release = normalizeReleaseDetail(raw);
    this.cache.releases[releaseId] = { cachedAt: now, release };
    this.persistCache();
    return { release, cached: false };
  }

  saveSelection(selection) {
    this.cache.selection = selection;
    this.persistCache();
    return selection;
  }

  getSelection() {
    return this.cache.selection;
  }
}

module.exports = { DiscogsService, normalizeCollectionEntry, normalizeReleaseDetail };
