'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BotAvatarService, safeImageUrl, imageBufferLooksValid } = require('../src/main/services/bot-avatar-service.cjs');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'needlecast-avatar-test-')); }
function png(fill) { return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, fill)]); }
function imageResponse(buffer, contentType = 'image/png') {
  return { ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? contentType : String(buffer.length) }, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) };
}

test('only allows HTTPS album-art hosts plus Discord CDN for the original avatar', () => {
  assert.ok(safeImageUrl('https://is1-ssl.mzstatic.com/cover.jpg'));
  assert.ok(safeImageUrl('https://i.discogs.com/cover.jpg'));
  assert.equal(safeImageUrl('http://is1-ssl.mzstatic.com/cover.jpg'), null);
  assert.equal(safeImageUrl('https://127.0.0.1/cover.jpg'), null);
  assert.equal(safeImageUrl('https://cdn.discordapp.com/embed/avatars/1.png'), null);
  assert.ok(safeImageUrl('https://cdn.discordapp.com/embed/avatars/1.png', true));
});

test('checks image file signatures before sending images to Discord', () => {
  assert.equal(imageBufferLooksValid(png(0), 'image/png'), true);
  assert.equal(imageBufferLooksValid(Buffer.from('not png bytes'), 'image/png'), false);
});

test('sets bot avatar to album art and restores the stored original avatar', async () => {
  const dataDir = tempDir();
  const original = png(1);
  const cover = png(2);
  const calls = [];
  const fetchImpl = async (url) => url.includes('cdn.discordapp.com') ? imageResponse(original) : imageResponse(cover);
  const service = new BotAvatarService({ dataDir, fetchImpl });
  const clientUser = {
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png',
    async setAvatar(buffer) { calls.push(Buffer.from(buffer)); },
  };

  await service.updateFromCover(clientUser, 'https://is1-ssl.mzstatic.com/album.png');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], cover);
  assert.equal(service.state.avatarChanged, true);
  assert.ok(service.state.originalAvatarData);

  await service.restoreOriginal(clientUser);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], original);
  assert.equal(service.state.avatarChanged, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'discord-bot-avatar.json'), 'utf8')).avatarChanged, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('does not repeat an album avatar upload for the same artwork while active', async () => {
  const dataDir = tempDir();
  const original = png(1);
  const cover = png(2);
  let uploaded = 0;
  const service = new BotAvatarService({ dataDir, fetchImpl: async (url) => url.includes('cdn.discordapp.com') ? imageResponse(original) : imageResponse(cover) });
  const clientUser = {
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png',
    async setAvatar() { uploaded += 1; },
  };
  await service.updateFromCover(clientUser, 'https://is1-ssl.mzstatic.com/album.png');
  await service.updateFromCover(clientUser, 'https://is1-ssl.mzstatic.com/album.png');
  assert.equal(uploaded, 1);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects non-image responses without changing the bot avatar', async () => {
  const service = new BotAvatarService({ dataDir: tempDir(), fetchImpl: async () => ({ ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/html' : '12' }, arrayBuffer: async () => Buffer.from('<html></html>') }) });
  let changed = false;
  const clientUser = { displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/1.png', async setAvatar() { changed = true; } };
  await service.updateFromCover(clientUser, 'https://is1-ssl.mzstatic.com/album.png');
  assert.equal(changed, false);
});
