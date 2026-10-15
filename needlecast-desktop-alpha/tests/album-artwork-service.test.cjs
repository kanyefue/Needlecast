'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AlbumArtworkService, artworkSizes, scoreAppleResult } = require('../src/main/services/album-artwork-service.cjs');

const appleArtwork = 'https://is1-ssl.mzstatic.com/image/thumb/Music123/100x100bb.jpg';

test('prefers exact Discogs release artwork when configured', async () => {
  let appleCalls = 0;
  const discogsService = {
    configured: true,
    async getRelease(id) {
      assert.equal(id, '12345');
      return { release: { coverImage: 'https://i.discogs.com/full.jpg', thumb: 'https://i.discogs.com/thumb.jpg' } };
    },
  };
  const service = new AlbumArtworkService({ discogsService, fetchImpl: async () => { appleCalls += 1; throw new Error('Apple should not be called'); } });
  const result = await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk', discogsId: '12345' });
  assert.equal(result.matched, true);
  assert.equal(result.artworkProvider, 'Discogs');
  assert.equal(result.coverImage, 'https://i.discogs.com/full.jpg');
  assert.equal(appleCalls, 0);
});

test('falls back to Apple album search and upgrades returned artwork sizes', async () => {
  let calls = 0;
  const service = new AlbumArtworkService({ fetchImpl: async (url) => {
    calls += 1;
    assert.match(String(url), /^https:\/\/itunes\.apple\.com\/search\?/);
    const params = new URL(url).searchParams;
    assert.equal(params.get('entity'), 'album');
    return { ok: true, json: async () => ({ results: [
      { collectionName: 'Random Access Memories', artistName: 'Random Artist', artworkUrl100: appleArtwork },
      { collectionName: 'Discovery', artistName: 'Daft Punk', artworkUrl100: appleArtwork, releaseDate: '2001-03-12T00:00:00Z' },
    ] }) };
  }, now: () => 10000 });
  const result = await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk', year: '2001' });
  assert.equal(result.matched, true);
  assert.equal(result.artworkProvider, 'Apple Music Search');
  assert.equal(result.coverImage, 'https://is1-ssl.mzstatic.com/image/thumb/Music123/600x600bb.jpg');
  assert.equal(result.thumb, 'https://is1-ssl.mzstatic.com/image/thumb/Music123/250x250bb.jpg');
  assert.equal(calls, 1);
});

test('does not select a clearly unrelated Apple album result', async () => {
  const service = new AlbumArtworkService({ fetchImpl: async () => ({ ok: true, json: async () => ({ results: [
    { collectionName: 'Different Record', artistName: 'Other Artist', artworkUrl100: appleArtwork },
  ] }) }) });
  const result = await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk' });
  assert.equal(result.matched, false);
  assert.equal(result.coverImage, '');
});

test('caches successful artwork lookups', async () => {
  let calls = 0;
  const service = new AlbumArtworkService({ fetchImpl: async () => {
    calls += 1;
    return { ok: true, json: async () => ({ results: [{ collectionName: 'Discovery', artistName: 'Daft Punk', artworkUrl100: appleArtwork }] }) };
  }, now: () => 10000 });
  await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk' });
  const second = await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk' });
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
});

test('validates that artwork URLs come from supported HTTPS image hosts', () => {
  assert.deepEqual(artworkSizes('http://example.com/art.jpg'), { thumb: '', coverImage: '' });
  assert.equal(scoreAppleResult({ collectionName: 'Discovery', artistName: 'Daft Punk', artworkUrl100: appleArtwork }, 'Discovery', 'Daft Punk', ''), 14);
});

test('does not cache a transient Apple Search API failure as a missing-cover result', async () => {
  let calls = 0;
  const service = new AlbumArtworkService({ fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary network failure');
    return { ok: true, json: async () => ({ results: [{ collectionName: 'Discovery', artistName: 'Daft Punk', artworkUrl100: appleArtwork }] }) };
  }, now: () => 10000 });
  const first = await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk' });
  assert.equal(first.matched, false);
  const second = await service.findArtwork({ title: 'Discovery', artist: 'Daft Punk' });
  assert.equal(second.matched, true);
  assert.equal(calls, 2);
});
