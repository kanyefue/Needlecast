'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_RELEASES = 100_000;

function normalizeHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** RFC 4180-style CSV parser supporting commas, CRLF, quoted newlines and doubled quotes. */
function parseCsv(input) {
  if (typeof input !== 'string') throw new Error('The CSV file must be text.');
  if (Buffer.byteLength(input, 'utf8') > MAX_CSV_BYTES) throw new Error('CSV files must be 10 MB or smaller.');
  const text = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
      field = '';
      if (rows.length > MAX_RELEASES + 1) throw new Error(`CSV contains more than ${MAX_RELEASES.toLocaleString()} rows.`);
    } else field += ch;
  }
  if (quoted) throw new Error('The CSV contains an unterminated quoted field. Re-export it from Discogs and try again.');
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('The CSV appears to be empty or contains only a header row.');

  const headers = rows.shift().map(normalizeHeader);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const pick = (cells, aliases) => {
    for (const alias of aliases) {
      const index = headerIndex.get(alias);
      if (index !== undefined && cells[index] !== undefined) return String(cells[index]).trim();
    }
    return '';
  };
  if (!headerIndex.has('artist') || !headerIndex.has('title')) {
    throw new Error('CSV needs Artist and Title columns. Use the standard Discogs collection export.');
  }

  const releases = [];
  rows.forEach((cells, index) => {
    const artist = pick(cells, ['artist', 'artists']);
    const title = pick(cells, ['title', 'release_title', 'album']);
    if (!artist && !title) return;
    if (!artist || !title) return;
    const rawDiscogsId = pick(cells, ['release_id', 'releaseid', 'id']);
    const discogsId = /^\d{1,12}$/.test(rawDiscogsId) ? Number(rawDiscogsId) : null;
    const label = pick(cells, ['label', 'labels']);
    const catalogNumber = pick(cells, ['catalog', 'catalog_number', 'catalog_no', 'catno', 'catalogue_number']);
    const format = pick(cells, ['format', 'formats']);
    const released = pick(cells, ['released', 'year', 'release_date']);
    const yearMatch = released.match(/(?:18|19|20|21)\d{2}/);
    const identity = `${discogsId || ''}\u0000${artist}\u0000${title}\u0000${index}`;
    const shortHash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
    const release = {
      id: `csv-${shortHash}`,
      source: 'csv',
      discogsId,
      title: title.slice(0, 300),
      artists: [artist.slice(0, 300)],
      artistText: artist.slice(0, 300),
      year: yearMatch ? yearMatch[0] : '',
      thumb: '',
      coverImage: '',
      formats: format ? [format.slice(0, 200)] : [],
      labels: label ? [label.slice(0, 200)] : [],
      catalogNumber: catalogNumber.slice(0, 100),
      collectionFolder: pick(cells, ['collectionfolder', 'collection_folder']),
      dateAdded: pick(cells, ['date_added', 'dateadded']) || null,
    };
    releases.push(release);
  });
  if (!releases.length) throw new Error('No records with both Artist and Title were found in this CSV.');
  return releases;
}

class LocalLibraryService {
  constructor({ dataDir } = {}) {
    this.file = path.join(dataDir || path.join(process.cwd(), '.needlecast-data'), 'local-library.json');
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        filename: String(parsed.filename || ''),
        importedAt: parsed.importedAt || null,
        releases: Array.isArray(parsed.releases) ? parsed.releases : [],
        selection: parsed.selection && typeof parsed.selection === 'object' ? parsed.selection : null,
      };
    } catch (_) {
      return { filename: '', importedAt: null, releases: [], selection: null };
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  importCsv(csv, filename = 'collection.csv') {
    const releases = parseCsv(csv);
    this.state = {
      filename: String(filename || 'collection.csv').replace(/[\\/]/g, '_').slice(0, 200),
      importedAt: new Date().toISOString(),
      releases,
      selection: this.state.selection,
    };
    this.persist();
    return { count: releases.length, filename: this.state.filename, importedAt: this.state.importedAt, releases };
  }

  getCollection() {
    return { count: this.state.releases.length, filename: this.state.filename, importedAt: this.state.importedAt, releases: this.state.releases };
  }

  findRelease(id) {
    return this.state.releases.find((release) => release.id === String(id)) || null;
  }

  getRelease(id) {
    const release = this.findRelease(id);
    if (!release) return null;
    return { ...release };
  }

  saveArtwork(id, artwork = {}) {
    const release = this.findRelease(id);
    if (!release) return null;
    const safeImageUrl = (value) => {
      try {
        const url = new URL(String(value || ''));
        const host = url.hostname.toLocaleLowerCase();
        const allowed = host === 'mzstatic.com' || host.endsWith('.mzstatic.com')
          || host === 'apple.com' || host.endsWith('.apple.com')
          || host === 'discogs.com' || host.endsWith('.discogs.com');
        return url.protocol === 'https:' && allowed ? url.href : '';
      } catch (_) { return ''; }
    };
    const thumb = safeImageUrl(artwork.thumb);
    const coverImage = safeImageUrl(artwork.coverImage);
    if (!thumb && !coverImage) return release;
    if (thumb) release.thumb = thumb;
    if (coverImage) release.coverImage = coverImage;
    if (artwork.artworkProvider) release.artworkProvider = String(artwork.artworkProvider).slice(0, 40);
    this.persist();
    return release;
  }

  saveSelection(selection) {
    this.state.selection = selection;
    this.persist();
    return selection;
  }

  getSelection() { return this.state.selection; }

  clearSelection() {
    this.state.selection = null;
    this.persist();
  }
}

module.exports = { LocalLibraryService, parseCsv, normalizeHeader, MAX_CSV_BYTES };
