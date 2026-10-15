'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function safeImageUrl(value, allowDiscordCdn = false) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const isArtworkHost = host === 'mzstatic.com' || host.endsWith('.mzstatic.com')
      || host === 'apple.com' || host.endsWith('.apple.com')
      || host === 'discogs.com' || host.endsWith('.discogs.com');
    const isDiscordCdn = allowDiscordCdn && (host === 'cdn.discordapp.com' || host === 'media.discordapp.net');
    return isArtworkHost || isDiscordCdn ? url : null;
  } catch (_) { return null; }
}

function imageBufferLooksValid(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

class BotAvatarService {
  constructor({ dataDir, fetchImpl = fetch } = {}) {
    this.file = path.join(dataDir || path.join(process.cwd(), '.needlecast-data'), 'discord-bot-avatar.json');
    this.fetch = fetchImpl;
    this.state = this.load();
    this.pending = null;
    this.running = false;
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        originalAvatarData: typeof saved.originalAvatarData === 'string' ? saved.originalAvatarData : '',
        avatarChanged: saved.avatarChanged === true,
        lastImageHash: typeof saved.lastImageHash === 'string' ? saved.lastImageHash : '',
      };
    } catch (_) {
      return { originalAvatarData: '', avatarChanged: false, lastImageHash: '' };
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  async fetchImage(value, allowDiscordCdn = false) {
    const url = safeImageUrl(value, allowDiscordCdn);
    if (!url) throw new Error('The image URL is not from a supported HTTPS artwork host.');
    const response = await this.fetch(url.href, {
      headers: { 'User-Agent': 'Needlecast/0.3.0 (album artwork profile avatar)', Accept: 'image/png,image/jpeg,image/webp,image/gif' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status}).`);
    const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ACCEPTED_TYPES.has(mimeType)) throw new Error(`Discord avatar image type is not supported (${mimeType || 'unknown'}).`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_IMAGE_BYTES) throw new Error('Album artwork is too large to use as a Discord avatar.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Album artwork must be between 1 byte and 5 MB.');
    if (!imageBufferLooksValid(buffer, mimeType)) throw new Error('The artwork response did not contain a valid image.');
    return buffer;
  }

  async captureOriginalAvatar(clientUser) {
    if (this.state.originalAvatarData) return;
    const url = clientUser.displayAvatarURL({ extension: 'png', size: 512 });
    const buffer = await this.fetchImage(url, true);
    this.state.originalAvatarData = buffer.toString('base64');
    this.persist();
  }

  enqueue(action) {
    this.pending = action; // Coalesce rapid selections so only the newest queued album is applied.
    return this.running ? Promise.resolve() : this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const action = this.pending;
        this.pending = null;
        if (action.type === 'cover') await this.applyCover(action).catch((error) => console.warn(`Needlecast bot avatar: ${error.message}`));
        else if (action.type === 'restore') await this.applyRestore(action).catch((error) => console.warn(`Needlecast bot avatar restore: ${error.message}`));
      }
    } finally {
      this.running = false;
      if (this.pending) await this.drain();
    }
  }

  updateFromCover(clientUser, coverUrl) {
    if (!clientUser || typeof clientUser.setAvatar !== 'function' || !coverUrl) return;
    return this.enqueue({ type: 'cover', clientUser, coverUrl });
  }

  restoreOriginal(clientUser) {
    if (!clientUser || typeof clientUser.setAvatar !== 'function') return;
    return this.enqueue({ type: 'restore', clientUser });
  }

  async applyCover({ clientUser, coverUrl }) {
    const cover = await this.fetchImage(coverUrl);
    // A newer album/stop request arrived while the image was downloading; let that action win.
    if (this.pending) return;
    const imageHash = crypto.createHash('sha256').update(cover).digest('hex');
    if (this.state.avatarChanged && imageHash === this.state.lastImageHash) return;
    await this.captureOriginalAvatar(clientUser);
    if (this.pending) return;
    await clientUser.setAvatar(cover);
    this.state.avatarChanged = true;
    this.state.lastImageHash = imageHash;
    this.persist();
    console.log('Needlecast updated the Discord bot avatar to the selected album artwork.');
  }

  async applyRestore({ clientUser }) {
    if (!this.state.avatarChanged) return;
    if (!this.state.originalAvatarData) throw new Error('The original bot avatar was not saved; leaving the current avatar unchanged.');
    await clientUser.setAvatar(Buffer.from(this.state.originalAvatarData, 'base64'));
    this.state.avatarChanged = false;
    this.state.lastImageHash = '';
    this.persist();
    console.log('Needlecast restored the Discord bot avatar.');
  }
}

module.exports = { BotAvatarService, safeImageUrl, imageBufferLooksValid, MAX_IMAGE_BYTES };
