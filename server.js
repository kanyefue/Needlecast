'use strict';

if (process.env.DESKTOP_MODE !== '1') require('dotenv').config();
const path = require('node:path');
const os = require('node:os');
const { DiscogsService } = require('./src/main/services/discogs-service.cjs');
const { LocalLibraryService, MAX_CSV_BYTES } = require('./src/main/services/library-service.cjs');
const { AlbumArtworkService } = require('./src/main/services/album-artwork-service.cjs');
const { BotAvatarService } = require('./src/main/services/bot-avatar-service.cjs');
const http = require('node:http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Client, GatewayIntentBits, ChannelType, ActivityType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const { PassThrough } = require('node:stream');

const PORT = Number(process.env.PORT || 3000);
const AUDIO_WS_PORT = Number(process.env.AUDIO_WS_PORT || 8765);
const TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const DISCOGS_USERNAME = process.env.DISCOGS_USERNAME || '';
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || '';
const BOT_PRESENCE_ENABLED = process.env.NEEDLECAST_BOT_PRESENCE !== '0';
const CLEAR_PRESENCE_ON_STOP = process.env.NEEDLECAST_CLEAR_PRESENCE_ON_STOP !== '0';
const BOT_AVATAR_FROM_ALBUM = process.env.NEEDLECAST_BOT_AVATAR_FROM_ALBUM !== '0';
const DESKTOP_MODE = process.env.DESKTOP_MODE === '1';
const LISTEN_HOST = DESKTOP_MODE ? '127.0.0.1' : '0.0.0.0';
const CAPTURE_AGENT_PORT = Number(process.env.CAPTURE_AGENT_PORT || 8766);
const DATA_DIR = process.env.NEEDLECAST_DATA_DIR || path.join(os.tmpdir(), 'needlecast');
const discogsService = new DiscogsService({ username: DISCOGS_USERNAME, token: DISCOGS_TOKEN, dataDir: DATA_DIR });
const libraryService = new LocalLibraryService({ dataDir: DATA_DIR });
const albumArtwork = new AlbumArtworkService({ discogsService });
const botAvatarService = new BotAvatarService({ dataDir: DATA_DIR });

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
if (DESKTOP_MODE) {
  // Block cross-origin browser writes to the loopback API. Native local processes are
  // outside the browser-origin security model, but the service is never bound to LAN.
  app.use('/api', (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.get('origin') !== `http://127.0.0.1:${PORT}`) return res.status(403).json({ error: 'Cross-origin request rejected.' });
    next();
  });
}
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
let connection = null;
let currentPcm = null;
let audioSocketConnected = false;
let audioFrames = 0;
let droppedAudioFrames = 0;
let lastAudioAt = null;
let lastError = null;
let activeChannelName = null;
let activeChannelId = null;
let audioResource = null;
let shutdownStarted = false;

player.on('error', (error) => {
  lastError = `Audio player: ${error.message}`;
  console.error(lastError);
});
player.on(AudioPlayerStatus.Playing, () => console.log('Discord audio player is playing.'));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, botReady: bot.isReady(), configured: Boolean(TOKEN && GUILD_ID) });
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    botConfigured: Boolean(TOKEN && GUILD_ID),
    botReady: bot.isReady(),
    botTag: bot.user?.tag || null,
    botPresenceEnabled: BOT_PRESENCE_ENABLED,
    connected: Boolean(connection && connection.state.status === VoiceConnectionStatus.Ready),
    channelName: activeChannelName,
    channelId: activeChannelId,
    audioSocketConnected,
    audioFrames,
    droppedAudioFrames,
    lastAudioAt,
    playerStatus: player.state.status,
    lastError,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    desktopMode: DESKTOP_MODE,
    captureAgentBase: `http://127.0.0.1:${CAPTURE_AGENT_PORT}`,
    settingsStatus: {
      discordConfigured: Boolean(TOKEN && GUILD_ID),
      discogsConfigured: Boolean(DISCOGS_USERNAME && DISCOGS_TOKEN),
    },
  });
});

app.get('/api/settings/status', (_req, res) => {
  res.json({
    desktopMode: DESKTOP_MODE,
    discordConfigured: Boolean(TOKEN && GUILD_ID),
    discogsConfigured: Boolean(DISCOGS_USERNAME && DISCOGS_TOKEN),
    discogsUsername: DISCOGS_USERNAME || null,
    guildId: GUILD_ID || null,
    botPresenceEnabled: BOT_PRESENCE_ENABLED,
    clearPresenceOnStop: CLEAR_PRESENCE_ON_STOP,
    botAvatarFromAlbum: BOT_AVATAR_FROM_ALBUM,
  });
});

app.get('/api/library/collection', (_req, res) => {
  const result = libraryService.getCollection();
  res.json(result);
});

app.post('/api/library/import-csv', (req, res) => {
  try {
    const csv = req.body?.csv;
    if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'Choose a non-empty CSV file first.' });
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) return res.status(413).json({ error: 'CSV files must be 10 MB or smaller.' });
    const result = libraryService.importCsv(csv, String(req.body?.filename || 'collection.csv'));
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not import this CSV file.' });
  }
});

app.get('/api/library/releases/:releaseId', async (req, res) => {
  const id = String(req.params.releaseId || '');
  let release = libraryService.getRelease(id);
  if (!release) return res.status(404).json({ error: 'Album not found in the local library.' });
  // If Discogs credentials are configured, first enrich from the exact release
  // ID in the CSV. Album art is resolved independently of track metadata.
  if (release.discogsId && discogsService.configured) {
    try {
      const enriched = await discogsService.getRelease(String(release.discogsId));
      release = { ...release, ...enriched.release, id: release.id, source: 'csv', discogsId: release.discogsId };
    } catch (_) { /* Optional Discogs enrichment must not block local-library access. */ }
  }
  if (!release.coverImage && !release.thumb) {
    const artwork = await albumArtwork.findArtwork({
      title: release.title,
      artist: release.artistText,
      year: release.year,
      discogsId: release.discogsId,
    });
    if (artwork.coverImage || artwork.thumb) {
      libraryService.saveArtwork(release.id, artwork);
      release = { ...release, ...artwork, id: release.id, source: 'csv', discogsId: release.discogsId };
    }
  }
  res.json({ release, cached: true, local: true });
});

function normalizeSelectionPayload(body) {
  const release = body?.release && typeof body.release === 'object' ? body.release : {};
  const title = String(release.title || release.releaseTitle || '').trim().slice(0, 200);
  const artist = String(release.artistText || release.artist || release.artists?.join?.(', ') || '').trim().slice(0, 200);
  if (!title) return { error: 'Choose an album first.' };
  return { selection: {
    releaseId: Number(release.discogsId || release.id) || null,
    localReleaseId: String(release.id || ''),
    source: String(release.source || 'manual').slice(0, 20),
    releaseTitle: title,
    artist,
    coverImage: /^https:\/\//i.test(String(release.coverImage || '')) ? String(release.coverImage).slice(0, 2000) : '',
    artworkProvider: String(release.artworkProvider || '').slice(0, 40),
    selectedAt: new Date().toISOString(),
  } };
}

function updatePresence(selection) {
  if (!selection) return;
  if (bot.isReady() && BOT_PRESENCE_ENABLED) {
    const activityText = `${selection.releaseTitle}${selection.artist ? ` — ${selection.artist}` : ''}`.slice(0, 128);
    try { bot.user.setActivity(activityText, { type: ActivityType.Listening }); } catch (_) { /* bot presence is optional */ }
  }
  if (BOT_AVATAR_FROM_ALBUM && bot.isReady()) {
    if (selection.coverImage) botAvatarService.updateFromCover(bot.user, selection.coverImage);
    else if (botAvatarService.state.avatarChanged) botAvatarService.restoreOriginal(bot.user);
  }
}

bot.once('ready', () => {
  const selection = libraryService.getSelection();
  if (selection) updatePresence(selection);
  else if (botAvatarService.state.avatarChanged) botAvatarService.restoreOriginal(bot.user);
  if (selection && !BOT_AVATAR_FROM_ALBUM && botAvatarService.state.avatarChanged) botAvatarService.restoreOriginal(bot.user);
});

function clearNowPlaying() {
  if (bot.isReady() && BOT_PRESENCE_ENABLED) {
    try { bot.user.setPresence({ activities: [] }); } catch (_) { /* optional */ }
  }
  libraryService.clearSelection();
  if (BOT_AVATAR_FROM_ALBUM && bot.isReady()) botAvatarService.restoreOriginal(bot.user);
}

app.post('/api/selection', (req, res) => {
  const parsed = normalizeSelectionPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    libraryService.saveSelection(parsed.selection);
    updatePresence(parsed.selection);
    res.json({ ok: true, selection: parsed.selection });
  } catch (error) {
    res.status(500).json({ error: `Could not save Now Playing: ${error.message}` });
  }
});

app.get('/api/selection', (_req, res) => res.json({ selection: libraryService.getSelection() }));
app.delete('/api/selection', (_req, res) => {
  clearNowPlaying();
  res.json({ ok: true, selection: null });
});

app.get('/api/discogs/collection', async (req, res) => {
  try {
    const result = await discogsService.getCollection(String(req.query.refresh || '') === 'true');
    const query = String(req.query.q || '').trim().slice(0, 200).toLocaleLowerCase();
    const releases = query ? result.releases.filter((release) =>
      `${release.title} ${release.artistText} ${release.year} ${release.labels.join(' ')}`.toLocaleLowerCase().includes(query)) : result.releases;
    res.json({
      username: DISCOGS_USERNAME,
      count: result.releases.length,
      filteredCount: releases.length,
      cachedAt: new Date(result.cachedAt).toISOString(),
      releases,
    });
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || 'Could not load your Discogs collection.' });
  }
});

app.get('/api/discogs/releases/:releaseId', async (req, res) => {
  const releaseId = String(req.params.releaseId || '');
  if (!/^\d{1,12}$/.test(releaseId)) return res.status(400).json({ error: 'Invalid Discogs release ID.' });
  try {
    const result = await discogsService.getRelease(releaseId);
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || 'Could not load this album.' });
  }
});

app.post('/api/discogs/selection', (req, res) => {
  // Compatibility alias for pre-alpha UI clients. Selection is now library-agnostic.
  const parsed = normalizeSelectionPayload(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  libraryService.saveSelection(parsed.selection);
  updatePresence(parsed.selection);
  return res.json({ ok: true, selection: parsed.selection });
});

app.get('/api/discogs/selection', (_req, res) => res.json({ selection: libraryService.getSelection() }));

app.get('/api/artwork/album', async (req, res) => {
  try {
    const result = await albumArtwork.findArtwork({
      title: req.query.title,
      artist: req.query.artist,
      year: req.query.year,
      discogsId: req.query.discogsId,
    });
    const localReleaseId = String(req.query.localReleaseId || '').slice(0, 100);
    if (localReleaseId && (result.coverImage || result.thumb)) {
      libraryService.saveArtwork(localReleaseId, result);
    }
    res.json({ result });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not look up album artwork.' });
  }
});

app.get('/api/channels', async (_req, res) => {
  if (!TOKEN || !GUILD_ID) return res.status(400).json({ error: 'Configure a Discord bot token and server ID in Needlecast Settings, or set DISCORD_TOKEN and GUILD_ID in .env for Docker mode.' });
  if (!bot.isReady()) return res.status(503).json({ error: 'Discord bot is not ready yet. Check the token and Docker logs.' });
  try {
    const guild = await bot.guilds.fetch(GUILD_ID);
    const channels = await guild.channels.fetch();
    const voiceChannels = [...channels.values()]
      .filter((ch) => ch && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice))
      .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type === ChannelType.GuildStageVoice ? 'stage' : 'voice' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels: voiceChannels, guildName: guild.name });
  } catch (error) {
    lastError = `Could not list voice channels: ${error.message}`;
    res.status(502).json({ error: lastError });
  }
});

app.post('/api/stream/start', async (req, res) => {
  const channelId = String(req.body?.channelId || '');
  if (!TOKEN || !GUILD_ID) return res.status(400).json({ error: 'Discord bot is not configured. Open Needlecast Settings first.' });
  if (!channelId) return res.status(400).json({ error: 'Choose a Discord voice channel first.' });
  if (!bot.isReady()) return res.status(503).json({ error: 'Discord bot is not ready yet.' });

  try {
    const guild = await bot.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      return res.status(400).json({ error: 'That channel is not a usable voice channel in the configured server.' });
    }
    if (!channel.joinable || !channel.speakable) {
      return res.status(403).json({ error: 'The bot needs View Channel, Connect, and Speak permissions for that voice channel.' });
    }

    if (connection) {
      try { connection.destroy(); } catch (_) { /* already disconnected */ }
      connection = null;
    }
    if (currentPcm) {
      try { currentPcm.destroy(); } catch (_) { /* already destroyed */ }
    }
    currentPcm = new PassThrough({ highWaterMark: 48_000 });
    audioResource = createAudioResource(currentPcm, { inputType: StreamType.Raw });
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    connection.subscribe(player);
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    player.play(audioResource);
    activeChannelName = channel.name;
    activeChannelId = channel.id;
    audioFrames = 0;
    droppedAudioFrames = 0;
    lastAudioAt = null;
    lastError = null;
    res.json({ ok: true, channelName: channel.name });
  } catch (error) {
    lastError = `Could not start Discord stream: ${error.message}`;
    console.error(lastError);
    if (connection) {
      try { connection.destroy(); } catch (_) { /* ignored */ }
    }
    connection = null;
    activeChannelName = null;
    activeChannelId = null;
    if (currentPcm) {
      try { currentPcm.destroy(); } catch (_) { /* ignored */ }
    }
    currentPcm = null;
    res.status(502).json({ error: lastError });
  }
});

app.post('/api/stream/stop', (_req, res) => {
  try { player.stop(true); } catch (_) { /* ignored */ }
  if (connection) {
    try { connection.destroy(); } catch (_) { /* ignored */ }
  }
  connection = null;
  if (currentPcm) {
    try { currentPcm.destroy(); } catch (_) { /* ignored */ }
  }
  currentPcm = null;
  audioResource = null;
  activeChannelName = null;
  activeChannelId = null;
  audioSocketConnected = false;
  lastError = null;
  if (CLEAR_PRESENCE_ON_STOP) clearNowPlaying();
  res.json({ ok: true, selection: libraryService.getSelection() });
});

const webServer = http.createServer(app);
const audioWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const statusWss = new WebSocketServer({ noServer: true });

webServer.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (DESKTOP_MODE && origin && origin !== `http://127.0.0.1:${PORT}`) return socket.destroy();
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/audio') {
    audioWss.handleUpgrade(request, socket, head, (ws) => audioWss.emit('connection', ws, request));
  } else if (pathname === '/ws-status') {
    statusWss.handleUpgrade(request, socket, head, (ws) => statusWss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

audioWss.on('connection', (ws) => {
  if (!currentPcm || currentPcm.destroyed) {
    ws.close(1011, 'Start the Discord stream from the dashboard before capture.');
    return;
  }
  if (audioSocketConnected) {
    ws.close(1008, 'Only one capture agent may be connected at a time.');
    return;
  }
  audioSocketConnected = true;
  lastError = null;
  console.log('Host capture agent connected.');

  ws.on('message', (data, isBinary) => {
    if (!isBinary || !currentPcm || currentPcm.destroyed) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // 48 kHz, stereo, signed 16-bit little-endian PCM from the host agent.
    if (buffer.length > 0) {
      const frames = Math.floor(buffer.length / 4);
      // Bound latency/memory if the encoder or network stalls; discard stale live audio instead.
      if (currentPcm.writableLength > 48_000) {
        droppedAudioFrames += frames;
        return;
      }
      currentPcm.write(buffer);
      audioFrames += frames;
      lastAudioAt = new Date().toISOString();
    }
  });
  ws.on('close', () => {
    audioSocketConnected = false;
    console.log('Host capture agent disconnected.');
  });
  ws.on('error', (error) => {
    lastError = `Audio WebSocket: ${error.message}`;
    audioSocketConnected = false;
  });
});

statusWss.on('connection', (ws) => {
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      botReady: bot.isReady(),
      connected: Boolean(connection && connection.state.status === VoiceConnectionStatus.Ready),
      channelName: activeChannelName,
      audioSocketConnected,
      playerStatus: player.state.status,
      lastError,
    }));
  }, 1000);
  ws.on('close', () => clearInterval(timer));
});

webServer.listen(PORT, LISTEN_HOST, () => {
  console.log(`Dashboard listening on http://localhost:${PORT}`);
  console.log(`Host audio relay listening on ws://127.0.0.1:${AUDIO_WS_PORT}/audio`);
});

// The dashboard is localhost-only through Docker port publishing; the audio relay uses its own port.
const audioServer = http.createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Audio relay WebSocket endpoint.');
});
audioServer.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  if (DESKTOP_MODE && origin && origin !== `http://127.0.0.1:${PORT}`) return socket.destroy();
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname !== '/audio') return socket.destroy();
  audioWss.handleUpgrade(request, socket, head, (ws) => audioWss.emit('connection', ws, request));
});
audioServer.listen(AUDIO_WS_PORT, LISTEN_HOST, () => {
  console.log(`Audio relay ready on port ${AUDIO_WS_PORT}`);
});

if (TOKEN) {
  bot.login(TOKEN).catch((error) => {
    lastError = `Discord login failed: ${error.message}`;
    console.error(lastError);
  });
} else {
  console.warn('DISCORD_TOKEN is not set; UI will run, but Discord features are disabled.');
}

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try { player.stop(true); } catch (_) { /* ignored */ }
  if (connection) { try { connection.destroy(); } catch (_) { /* ignored */ } }
  if (currentPcm) { try { currentPcm.destroy(); } catch (_) { /* ignored */ } }
  try { if (CLEAR_PRESENCE_ON_STOP) clearNowPlaying(); } catch (_) { /* ignored */ }
  try { bot.destroy(); } catch (_) { /* ignored */ }
  await Promise.all([
    new Promise((resolve) => webServer.close(() => resolve())),
    new Promise((resolve) => audioServer.close(() => resolve())),
  ]);
  if (!DESKTOP_MODE) process.exit(0);
}

global.__needlecastShutdown = shutdown;
if (!DESKTOP_MODE) {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { shutdown };
