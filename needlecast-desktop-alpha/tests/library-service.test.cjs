'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalLibraryService, parseCsv } = require('../src/main/services/library-service.cjs');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'needlecast-library-test-')); }

const sampleCsv = [
  'Catalog#,Artist,Title,Label,Format,Released,release_id,CollectionFolder,Date Added',
  'CAT-1,Daft Punk,"Random, Access Memories",Columbia,"2xLP, Album",2013,123,LPs,2026-10-01',
  'CAT-2,"Artist ""With Quotes""",Another Album,Indie,LP,1998,456,LPs,2026-10-02',
].join('\r\n');

test('parses Discogs CSV exports including quoted commas and escaped quotes', () => {
  const releases = parseCsv(sampleCsv);
  assert.equal(releases.length, 2);
  assert.equal(releases[0].title, 'Random, Access Memories');
  assert.equal(releases[0].artistText, 'Daft Punk');
  assert.equal(releases[0].discogsId, 123);
  assert.equal(releases[0].formats[0], '2xLP, Album');
  assert.equal(releases[1].artistText, 'Artist "With Quotes"');
  assert.equal(releases[1].year, '1998');
});

test('imports the album library and persists artwork across service restarts', () => {
  const dir = tempDir();
  try {
    const service = new LocalLibraryService({ dataDir: dir });
    const imported = service.importCsv(sampleCsv, 'discogs-export.csv');
    assert.equal(imported.count, 2);
    assert.equal(service.getCollection().filename, 'discogs-export.csv');
    const first = imported.releases[0];
    service.saveArtwork(first.id, {
      thumb: 'https://is1-ssl.mzstatic.com/image/thumb/Music/250x250bb.jpg',
      coverImage: 'https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg',
      artworkProvider: 'Apple Music Search',
    });
    const reloaded = new LocalLibraryService({ dataDir: dir });
    assert.equal(reloaded.getCollection().count, 2);
    assert.equal(reloaded.getRelease(first.id).coverImage, 'https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg');
    assert.equal(reloaded.getRelease(first.id).artworkProvider, 'Apple Music Search');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects CSV without Artist and Title columns and malformed quoted fields', () => {
  assert.throws(() => parseCsv('Name,Album\nSomeone,Record'), /needs Artist and Title/);
  assert.throws(() => parseCsv('Artist,Title\nArtist,"unfinished'), /unterminated quoted field/);
});

test('clears persisted Now Playing independently of collection contents', () => {
  const dir = tempDir();
  try {
    const service = new LocalLibraryService({ dataDir: dir });
    service.importCsv(sampleCsv);
    service.saveSelection({ releaseTitle: 'Album', trackTitle: 'Song' });
    service.clearSelection();
    const reloaded = new LocalLibraryService({ dataDir: dir });
    assert.equal(reloaded.getSelection(), null);
    assert.equal(reloaded.getCollection().count, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
