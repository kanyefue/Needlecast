'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DiscogsService, normalizeCollectionEntry, normalizeReleaseDetail } = require('../src/main/services/discogs-service.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'needlecast-test-'));
}

test('normalizes a Discogs collection item to an album-first card model', () => {
  const result = normalizeCollectionEntry({
    instance_id: 123,
    date_added: '2026-01-01T00:00:00-00:00',
    basic_information: {
      id: 456,
      title: 'Example Album',
      year: 1999,
      thumb: 'https://i.discogs.com/example.jpg',
      artists: [{ name: 'The Example Band' }],
      labels: [{ name: 'Example Records' }],
      formats: [{ name: 'Vinyl', descriptions: ['LP', 'Album'] }],
    },
  });
  assert.equal(result.id, 456);
  assert.equal(result.instanceId, 123);
  assert.equal(result.title, 'Example Album');
  assert.equal(result.artistText, 'The Example Band');
  assert.equal(result.formats[0], 'Vinyl · LP · Album');
});

test('normalizes release cover art and Discogs source URL', () => {
  const result = normalizeReleaseDetail({
    id: 456,
    title: 'Example Album',
    artists: [{ name: 'The Example Band' }],
    thumb: 'https://i.discogs.com/thumb.jpg',
    images: [{ type: 'primary', uri: 'https://i.discogs.com/front.jpg' }],
    uri: 'https://www.discogs.com/release/456-example-album',
  });
  assert.equal(result.thumb, 'https://i.discogs.com/thumb.jpg');
  assert.equal(result.coverImage, 'https://i.discogs.com/front.jpg');
  assert.equal(result.uri, 'https://www.discogs.com/release/456-example-album');
  assert.equal('tracklist' in result, false);
});

test('paginates a collection and reuses its cache', async () => {
  const dir = tempDir();
  const service = new DiscogsService({ username: 'listener', token: 'never-log-this', dataDir: dir });
  let requests = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests += 1;
    assert.match(options.headers.Authorization, /^Discogs token=/);
    const page = new URL(url).searchParams.get('page');
    return {
      ok: true,
      json: async () => page === '1'
        ? { releases: [{ basic_information: { id: 1, title: 'One', artists: [{ name: 'Artist' }] } }], pagination: { pages: 2 } }
        : { releases: [{ basic_information: { id: 2, title: 'Two', artists: [{ name: 'Artist' }] } }], pagination: { pages: 2 } },
    };
  };
  try {
    const first = await service.getCollection();
    assert.equal(first.releases.length, 2);
    const second = await service.getCollection();
    assert.equal(second.releases.length, 2);
    assert.equal(requests, 2);
    const cachePath = path.join(dir, `discogs-cache-${crypto.createHash('sha256').update('listener').digest('hex').slice(0, 12)}.json`);
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).collection.releases.length, 2);
    const reloadedService = new DiscogsService({ username: 'listener', token: 'never-log-this', dataDir: dir });
    const reloaded = await reloadedService.getCollection();
    assert.equal(reloaded.releases.length, 2);
    assert.equal(requests, 2, 'a fresh on-disk cache avoids another API request');
    const otherUser = new DiscogsService({ username: 'another-listener', token: 'another-token', dataDir: dir });
    assert.notEqual(otherUser.cacheFile, service.cacheFile, 'different Discogs accounts must not share metadata caches');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects Discogs requests when credentials are missing', async () => {
  const service = new DiscogsService({ username: '', token: '', dataDir: tempDir() });
  await assert.rejects(() => service.getCollection(), /Connect Discogs in Settings/);
});
