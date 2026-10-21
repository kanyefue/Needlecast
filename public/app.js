'use strict';

let AGENT = 'http://127.0.0.1:8766';
const $ = (id) => document.getElementById(id);
const ui = {
  device: $('device-select'), channel: $('channel-select'), gain: $('gain-range'), gainValue: $('gain-value'),
  bass: $('eq-bass'), bassValue: $('eq-bass-value'), mid: $('eq-mid'), midValue: $('eq-mid-value'),
  treble: $('eq-treble'), trebleValue: $('eq-treble-value'), rumbleFilter: $('rumble-filter'), humFilter: $('hum-filter'), limiter: $('limiter-enabled'),
  processingBadge: $('processing-badge'), processingStatus: $('processing-status'), eqPresets: [...document.querySelectorAll('[data-eq-preset]')],
  refreshDevices: $('refresh-devices'), refreshChannels: $('refresh-channels'), start: $('start-button'), stop: $('stop-button'),
  actionHint: $('action-hint'), error: $('error-box'), notice: $('notice'), levelBar: $('level-bar'), meterReadout: $('meter-readout'),
  waveBars: $('wave-bars'), liveBadge: $('live-badge'), screenState: $('screen-state'),
};
const libraryUi = {
  search: $('collection-search'), grid: $('album-grid'), status: $('collection-status'), count: $('collection-count'),
  refresh: $('refresh-collection'), local: $('reload-local-library'), import: $('import-csv-button'), file: $('csv-file'), manual: $('manual-track-button'), releasePanel: $('release-panel'), selectedStrip: $('selected-track-strip'),
  selectedTitle: $('selected-track-title'), selectedRelease: $('selected-track-release'),
};
const settingsUi = {
  dialog: $('settings-dialog'), open: $('open-settings'), close: $('close-settings'), form: $('settings-form'), message: $('settings-message'), save: $('save-settings'),
  discordToken: $('discord-token'), guildId: $('guild-id'), discogsUsername: $('discogs-username'), discogsToken: $('discogs-token'),
  clearDiscord: $('clear-discord'), clearDiscogs: $('clear-discogs'),
  botPresenceEnabled: $('bot-presence-enabled'), clearPresenceOnStop: $('clear-presence-on-stop'), botAvatarFromAlbum: $('bot-avatar-from-album'),
};
const manualUi = { dialog: $('manual-track-dialog'), form: $('manual-track-form'), close: $('close-manual-track'), artist: $('manual-artist'), album: $('manual-album'), message: $('manual-track-message') };

let isStarting = false;
let agentOnline = false;
let backendStatus = {};
let agentStatus = {};
let localError = null;
let selectedDefaultDevice = null;
let collectionReleases = [];
let activeRelease = null;
let collectionSource = 'local';
let settingsStatus = { desktopMode: false, discordConfigured: false, discogsConfigured: false };
const artworkAttempted = new Set();
const artworkQueue = [];
let artworkRequestsActive = 0;
const MAX_ARTWORK_REQUESTS = 2;
let artworkObserver = null;
let processingTimer = null;
const DEFAULT_AUDIO_PROCESSING = { bassDb: 0, midDb: 0, trebleDb: 0, rumbleFilter: true, humFilterHz: 50, limiterEnabled: true };
const EQ_PRESETS = {
  flat: { label: 'Flat', config: { ...DEFAULT_AUDIO_PROCESSING } },
  warm: { label: 'Warm', config: { bassDb: 2, midDb: 0, trebleDb: -1, rumbleFilter: true, humFilterHz: 50, limiterEnabled: true } },
  clarity: { label: 'Clarity', config: { bassDb: -1, midDb: 1, trebleDb: 2, rumbleFilter: true, humFilterHz: 50, limiterEnabled: true } },
};

function getAudioProcessingConfig() {
  return {
    bassDb: Number(ui.bass.value),
    midDb: Number(ui.mid.value),
    trebleDb: Number(ui.treble.value),
    rumbleFilter: Boolean(ui.rumbleFilter.checked),
    humFilterHz: [0, 50, 60].includes(Number(ui.humFilter.value)) ? Number(ui.humFilter.value) : 50,
    limiterEnabled: Boolean(ui.limiter.checked),
  };
}

function setAudioProcessingControls(config = DEFAULT_AUDIO_PROCESSING) {
  const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(-6, Math.min(6, Number(value))) : fallback;
  ui.bass.value = String(safeNumber(config.bassDb));
  ui.mid.value = String(safeNumber(config.midDb));
  ui.treble.value = String(safeNumber(config.trebleDb));
  ui.rumbleFilter.checked = config.rumbleFilter !== false;
  ui.humFilter.value = String([0, 50, 60].includes(Number(config.humFilterHz)) ? Number(config.humFilterHz) : 50);
  ui.limiter.checked = config.limiterEnabled !== false;
  updateAudioProcessingLabels();
}

function updateAudioProcessingLabels() {
  const config = getAudioProcessingConfig();
  ui.bassValue.textContent = formatDb(config.bassDb);
  ui.midValue.textContent = formatDb(config.midDb);
  ui.trebleValue.textContent = formatDb(config.trebleDb);
  const presetEntry = Object.entries(EQ_PRESETS).find(([, preset]) =>
    preset.config.bassDb === config.bassDb && preset.config.midDb === config.midDb &&
    preset.config.trebleDb === config.trebleDb && preset.config.rumbleFilter === config.rumbleFilter &&
    preset.config.humFilterHz === config.humFilterHz && preset.config.limiterEnabled === config.limiterEnabled);
  const presetName = presetEntry ? presetEntry[1].label.toUpperCase() : 'CUSTOM';
  ui.processingBadge.textContent = `${presetName} · HUM ${config.humFilterHz ? `${config.humFilterHz} HZ` : 'OFF'} · PEAK ${config.limiterEnabled ? 'ON' : 'OFF'}`;
  ui.eqPresets.forEach((button) => {
    const active = presetEntry?.[0] === button.dataset.eqPreset;
    button.classList.toggle('active', Boolean(active));
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function restoreAudioProcessingPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem('needlecast.audioProcessing') || 'null');
    if (saved && typeof saved === 'object') setAudioProcessingControls({ ...DEFAULT_AUDIO_PROCESSING, ...saved });
    else setAudioProcessingControls(DEFAULT_AUDIO_PROCESSING);
  } catch (_) {
    setAudioProcessingControls(DEFAULT_AUDIO_PROCESSING);
  }
}

function saveAudioProcessingPreferences() {
  try { localStorage.setItem('needlecast.audioProcessing', JSON.stringify(getAudioProcessingConfig())); } catch (_) { /* settings can still be used until the window closes */ }
}

function updateProcessingStatus(status = agentStatus) {
  const config = getAudioProcessingConfig();
  const sourcePeak = Number(status.sourcePeak || 0);
  const reduction = Number(status.limiterReductionDb || 0);
  const peak = Number(status.peak || 0);
  if (status.streaming && sourcePeak >= 0.995) {
    ui.processingStatus.textContent = 'Input clipping detected at the sound-card input. Lower its hardware/Windows level; the limiter cannot repair already-clipped audio.';
    ui.processingStatus.classList.add('warning');
  } else if (status.streaming && config.limiterEnabled && reduction > 0.5) {
    ui.processingStatus.textContent = `Peak protection is reducing peaks by ${reduction.toFixed(1)} dB. Hum reduction ${config.humFilterHz ? `at ${config.humFilterHz} Hz + harmonics` : 'is off'}. Lower input gain if this happens often.`;
    ui.processingStatus.classList.remove('warning');
  } else if (status.streaming && !config.limiterEnabled && peak >= 0.89) {
    ui.processingStatus.textContent = 'Signal is close to digital clipping. Turn peak protection on or reduce input gain.';
    ui.processingStatus.classList.add('warning');
  } else {
    ui.processingStatus.textContent = `${config.rumbleFilter ? '30 Hz rumble filter on' : 'rumble filter off'} · ${config.humFilterHz ? `${config.humFilterHz} Hz hum reduction on` : 'hum reduction off'} · ${config.limiterEnabled ? 'peak protection on' : 'peak protection off'}.`;
    ui.processingStatus.classList.remove('warning');
  }
}

async function syncAudioProcessingToAgent() {
  if (!agentOnline) return false;
  const config = getAudioProcessingConfig();
  try {
    await post(`${AGENT}/api/processing`, config);
    updateProcessingStatus(agentStatus);
    return true;
  } catch (error) {
    ui.processingStatus.textContent = `Could not apply audio settings: ${error.message}`;
    ui.processingStatus.classList.add('warning');
    return false;
  }
}

function scheduleAudioProcessingUpdate() {
  updateAudioProcessingLabels();
  saveAudioProcessingPreferences();
  updateProcessingStatus(agentStatus);
  window.clearTimeout(processingTimer);
  processingTimer = window.setTimeout(() => {
    void syncAudioProcessingToAgent();
  }, 200);
}

// A restrained live waveform: activity is driven by the measured RMS level.
const bars = [];
for (let i = 0; i < 64; i += 1) {
  const bar = document.createElement('span');
  bar.className = 'wave-bar';
  bar.style.height = '3px';
  ui.waveBars.appendChild(bar);
  bars.push(bar);
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch (error) {
    throw new Error(`Can't reach ${url.startsWith(AGENT) ? 'the local capture agent' : 'the Needlecast backend'}. ${error.message}`);
  }
  let body = {};
  try { body = await response.json(); } catch (_) { /* non-JSON response */ }
  if (!response.ok) throw new Error(body.error || body.detail || `Request failed (${response.status})`);
  return body;
}

const post = (url, body = {}) => request(url, { method: 'POST', body: JSON.stringify(body) });

function showError(message) {
  localError = message || null;
  renderError();
}
function renderError() {
  const message = agentStatus.lastError || backendStatus.lastError || localError;
  ui.error.hidden = !message;
  ui.error.textContent = message || '';
}
function setLoading(button, loading, textWhenLoading) {
  button.disabled = loading;
  const span = button.querySelector('span:nth-child(2)');
  if (span) {
    button.dataset.originalLabel ||= span.textContent.trim();
    span.textContent = loading ? textWhenLoading : button.dataset.originalLabel;
  }
}
function setDot(id, good, bad = false) {
  $(id).className = `status-dot${good ? ' ok' : bad ? ' bad' : ''}`;
}
function formatDb(value) {
  const number = Number(value);
  return `${number < 0 ? '−' : number > 0 ? '+' : ''}${Math.abs(number)} dB`;
}
function setSelectOptions(select, options, placeholder, selectedValue = null) {
  const previous = selectedValue ?? select.value;
  select.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.appendChild(first);
  for (const item of options) {
    const option = document.createElement('option');
    option.value = String(item.value);
    option.textContent = item.label;
    select.appendChild(option);
  }
  if (options.some((item) => String(item.value) === String(previous))) select.value = String(previous);
}

async function refreshDevices() {
  ui.refreshDevices.disabled = true;
  try {
    const result = await request(`${AGENT}/api/devices`);
    agentOnline = true;
    selectedDefaultDevice = result.defaultInputIndex;
    const options = result.devices.map((d) => ({ value: d.index, label: `${d.name} · ${d.inputChannels} ch · ${d.hostApi}` }));
    setSelectOptions(ui.device, options, options.length ? 'Select an audio input…' : 'No input devices found');
    if (ui.device.value === '' && selectedDefaultDevice !== null && options.some((o) => String(o.value) === String(selectedDefaultDevice))) {
      ui.device.value = String(selectedDefaultDevice);
    }
    if (options.length === 0) ui.actionHint.textContent = 'No recording inputs were found. Connect an input and refresh the device list.';
  } catch (error) {
    agentOnline = false;
    setSelectOptions(ui.device, [], 'Start the Windows capture agent first');
    ui.actionHint.textContent = 'The desktop app starts its capture agent automatically. Check the agent log and refresh device discovery.';
    showError(error.message);
  } finally {
    ui.refreshDevices.disabled = false;
  }
  await refreshStatus();
}

async function refreshChannels() {
  ui.refreshChannels.disabled = true;
  try {
    const result = await request('/api/channels');
    setSelectOptions(ui.channel, result.channels.map((c) => ({ value: c.id, label: `${c.name}${c.type === 'stage' ? ' · Stage' : ''}` })), result.channels.length ? `Choose a channel in ${result.guildName}…` : 'No voice channels visible');
    ui.channel.disabled = result.channels.length === 0;
  } catch (error) {
    setSelectOptions(ui.channel, [], 'Configure Discord in Settings');
    ui.channel.disabled = false;
    if (!String(error.message).includes('not ready yet')) showError(error.message);
  } finally {
    ui.refreshChannels.disabled = false;
  }
}

function updateMeter(status) {
  const peak = Math.max(0, Math.min(1, Number(status.peak || 0)));
  const rms = Math.max(0, Number(status.rms || 0));
  ui.levelBar.style.width = `${peak * 100}%`;
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  ui.meterReadout.textContent = db > -60 ? `${db.toFixed(1)} dBFS PEAK` : 'NO SIGNAL';
  ui.meterReadout.classList.toggle('signal', db > -60);
  const active = Boolean(status.streaming && rms > 0.0005);
  $('waveform').classList.toggle('active', active);
  const energy = Math.min(1, rms * 7.5);
  for (let i = 0; i < bars.length; i += 1) {
    // Stable deterministic shape with motion based only on the real signal level.
    const envelope = 0.12 + 0.88 * Math.abs(Math.sin(i * 1.21) * Math.cos(i * 0.29));
    const height = active ? Math.max(3, (4 + energy * 53 * envelope)) : 3;
    bars[i].style.height = `${height}px`;
    bars[i].style.opacity = active ? String(0.45 + envelope * 0.5) : '0.3';
  }
  updateProcessingStatus(status);
}

function updateStatus() {
  const botReady = Boolean(backendStatus.botReady);
  $('bot-status').textContent = botReady ? 'Ready' : (backendStatus.botConfigured ? 'Connecting…' : 'Needs setup');
  $('bot-detail').textContent = backendStatus.botTag || (botReady ? 'Connected to Discord' : 'Open Settings to configure bot');
  setDot('bot-dot', botReady, !backendStatus.botConfigured);

  $('agent-status').textContent = agentOnline ? (agentStatus.streaming ? 'Capturing audio' : 'Online') : 'Offline';
  $('agent-detail').textContent = agentOnline ? (agentStatus.selectedDeviceName || 'Host device access ready') : 'Run the Windows capture agent';
  setDot('agent-dot', agentOnline && agentStatus.streaming, !agentOnline);

  const audioConnected = Boolean(backendStatus.audioSocketConnected && agentStatus.connectedToRelay);
  const opusBitrate = Number(backendStatus.opusBitrate || 0);
  $('opus-bitrate-value').textContent = opusBitrate > 0 ? `${Math.round(opusBitrate / 1000)} kbps` : 'Auto / channel';
  $('audio-status').textContent = audioConnected ? 'Receiving audio' : (backendStatus.connected ? 'Waiting for input' : 'Standby');
  $('audio-detail').textContent = audioConnected ? 'Host → relay · live PCM' : '48 kHz · stereo PCM';
  setDot('audio-dot', audioConnected, Boolean(backendStatus.lastError || agentStatus.lastError));

  $('route-input').textContent = agentStatus.selectedDeviceName || (ui.device.selectedOptions[0]?.textContent || 'Not selected');
  $('route-input-state').textContent = agentStatus.streaming ? 'CAPTURING' : (agentOnline ? 'READY' : 'OFFLINE');
  $('route-input-state').classList.toggle('ok', agentOnline && agentStatus.streaming);
  $('route-relay').textContent = audioConnected ? 'Connected · PCM stream active' : 'Local WebSocket · awaiting stream';
  $('route-relay-state').textContent = audioConnected ? 'CONNECTED' : 'WAITING';
  $('route-relay-state').classList.toggle('ok', audioConnected);
  $('route-discord').textContent = backendStatus.channelName || 'No active channel';
  $('route-discord-state').textContent = backendStatus.connected ? 'BROADCASTING' : (backendStatus.botReady ? 'READY' : 'OFFLINE');
  $('route-discord-state').classList.toggle('ok', Boolean(backendStatus.connected));

  const live = Boolean(backendStatus.connected && audioConnected && agentStatus.streaming);
  ui.liveBadge.classList.toggle('on', live);
  ui.liveBadge.innerHTML = `<span></span> ${live ? 'LIVE' : 'STANDBY'}`;
  ui.screenState.textContent = live ? 'CARRIER LOCKED' : 'NO CARRIER';
  updateMeter(agentStatus);
  ui.start.disabled = isStarting || live || !agentOnline || !backendStatus.botReady;
  ui.stop.disabled = isStarting || (!backendStatus.connected && !agentStatus.streaming);

  renderError();
  if (live) ui.actionHint.textContent = `Broadcasting to ${backendStatus.channelName}. Keep the capture agent running.`;
  else if (isStarting) ui.actionHint.textContent = 'Connecting the bot and opening the selected audio input…';
  else if (!backendStatus.botReady) ui.actionHint.textContent = 'Open Settings to configure your Discord bot and server ID.';
  else if (!agentOnline) ui.actionHint.textContent = 'Waiting for the local audio capture service. Check its log, then refresh the input list.';
  else ui.actionHint.textContent = 'Choose an input and Discord voice channel, then start the broadcast.';
}

async function refreshStatus() {
  const wasAgentOnline = agentOnline;
  const [backend, agent] = await Promise.allSettled([request('/api/status'), request(`${AGENT}/api/status`)]);
  if (backend.status === 'fulfilled') backendStatus = backend.value;
  if (agent.status === 'fulfilled') {
    agentOnline = true;
    agentStatus = agent.value;
  } else {
    agentOnline = false;
    agentStatus = {};
  }
  updateStatus();
  // If the bundled agent starts slightly after the UI, automatically populate the
  // device list rather than asking the user to discover and refresh it manually.
  if (!wasAgentOnline && agentOnline) {
    if (ui.device.options[0]?.textContent === 'Start the Windows capture agent first') void refreshDevices();
    void syncAudioProcessingToAgent();
  }
}

async function startBroadcast() {
  if (isStarting) return;
  if (!ui.device.value) return showError('Select an audio input device first.');
  if (!ui.channel.value) return showError('Select a Discord voice channel first.');
  isStarting = true;
  setLoading(ui.start, true, 'Starting…');
  showError('');
  updateStatus();
  let discordStarted = false;
  try {
    await post('/api/stream/start', { channelId: ui.channel.value });
    discordStarted = true;
    await post(`${AGENT}/api/start`, { deviceIndex: Number(ui.device.value), gainDb: Number(ui.gain.value), ...getAudioProcessingConfig() });
    await refreshStatus();
  } catch (error) {
    if (discordStarted) {
      try { await post(`${AGENT}/api/stop`); } catch (_) { /* capture may not have started */ }
      try { await post('/api/stream/stop'); } catch (_) { /* ignore cleanup error */ }
    }
    showError(error.message);
  } finally {
    isStarting = false;
    setLoading(ui.start, false, 'Start broadcast');
    await refreshStatus();
  }
}

async function stopBroadcast() {
  if (isStarting) return;
  isStarting = true;
  ui.stop.disabled = true;
  showError('');
  try {
    // Stop capture first so the host's WebSocket closes cleanly before the Discord source is destroyed.
    try { await post(`${AGENT}/api/stop`); } catch (_) { /* capture may already be offline */ }
    const result = await post('/api/stream/stop');
    if (Object.prototype.hasOwnProperty.call(result, 'selection')) renderSelectedTrack(result.selection);
    await refreshStatus();
  } catch (error) {
    showError(error.message);
  } finally {
    isStarting = false;
    await refreshStatus();
  }
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function openSettings() {
  if (!settingsUi.dialog) return;
  settingsUi.message.textContent = settingsStatus.desktopMode
    ? 'Credentials are encrypted locally. Discogs is optional.'
    : 'In the browser/Docker prototype, credentials are managed through .env. Secure credential settings are available in the desktop app.';
  settingsUi.save.disabled = !window.needlecast?.saveSettings;
  if (!window.needlecast?.saveSettings) settingsUi.message.textContent = 'Settings are managed through .env in the web/Docker prototype.';
  settingsUi.discordToken.placeholder = settingsStatus.discordConfigured ? 'Saved securely — leave blank to keep current token' : 'Paste your Discord bot token';
  settingsUi.discogsToken.placeholder = settingsStatus.discogsConfigured ? 'Saved securely — leave blank to keep current token' : 'Optional Discogs personal access token';
  settingsUi.discogsUsername.value = settingsStatus.discogsUsername || settingsUi.discogsUsername.value || '';
  settingsUi.guildId.value = settingsStatus.guildId || settingsUi.guildId.value || '';
  settingsUi.botPresenceEnabled.checked = settingsStatus.botPresenceEnabled !== false;
  settingsUi.clearPresenceOnStop.checked = settingsStatus.clearPresenceOnStop !== false;
  settingsUi.botAvatarFromAlbum.checked = settingsStatus.botAvatarFromAlbum !== false;
  if (!settingsUi.dialog.open) settingsUi.dialog.showModal();
}

async function refreshSettingsStatus() {
  try {
    settingsStatus = await request('/api/settings/status');
  } catch (_) {
    settingsStatus = { desktopMode: false, discordConfigured: false, discogsConfigured: false, botPresenceEnabled: true, clearPresenceOnStop: true, botAvatarFromAlbum: true };
  }
  libraryUi.refresh.hidden = !settingsStatus.discogsConfigured;
  libraryUi.refresh.title = 'Synchronize collection from Discogs';
  libraryUi.local.title = 'Reload the imported local CSV library';
}

async function saveSettings(event) {
  event.preventDefault();
  if (!window.needlecast?.saveSettings) {
    settingsUi.message.textContent = 'This build uses .env configuration. Open the desktop app to save credentials securely.';
    return;
  }
  const payload = {
    discordToken: settingsUi.discordToken.value.trim(),
    guildId: settingsUi.guildId.value.trim(),
    discogsUsername: settingsUi.discogsUsername.value.trim(),
    discogsToken: settingsUi.discogsToken.value.trim(),
    clearDiscord: settingsUi.clearDiscord.checked,
    clearDiscogs: settingsUi.clearDiscogs.checked,
    botPresenceEnabled: settingsUi.botPresenceEnabled.checked,
    clearPresenceOnStop: settingsUi.clearPresenceOnStop.checked,
    botAvatarFromAlbum: settingsUi.botAvatarFromAlbum.checked,
  };
  settingsUi.save.disabled = true;
  settingsUi.message.textContent = 'Encrypting settings and restarting…';
  try {
    const result = await window.needlecast.saveSettings(payload);
    settingsUi.message.textContent = result.restarting ? 'Settings saved securely. Needlecast is restarting now.' : 'Settings saved.';
  } catch (error) {
    settingsUi.message.textContent = error.message || 'Could not save settings.';
    settingsUi.save.disabled = false;
  }
}

function imageInCover(cover, url, alt = '') {
  if (!cover || !url) return;
  const image = document.createElement('img');
  image.loading = 'lazy';
  image.alt = alt;
  image.referrerPolicy = 'no-referrer';
  image.src = url;
  image.addEventListener('error', () => {
    if (image.parentElement !== cover) return;
    const fallbackClass = cover.classList.contains('album-cover') ? 'album-cover-fallback' : '';
    cover.replaceChildren(textElement('span', fallbackClass, '◉'));
  }, { once: true });
  cover.replaceChildren(image);
}

function applyArtworkToCard(release) {
  const card = [...libraryUi.grid.querySelectorAll('.album-card')]
    .find((element) => element.dataset.releaseId === String(release.id));
  if (!card) return;
  const url = release.thumb || release.coverImage;
  if (url) imageInCover(card.querySelector('.album-cover'), url, `${release.title} cover`);
}

async function lookupArtwork(release) {
  const params = new URLSearchParams({
    title: release.title || '',
    artist: release.artistText || release.artists?.join?.(', ') || '',
    year: release.year || '',
  });
  const discogsId = release.discogsId || (release.source === 'discogs' ? release.id : null);
  if (discogsId) params.set('discogsId', String(discogsId));
  if (release.source === 'csv') params.set('localReleaseId', String(release.id));
  try {
    const response = await request(`/api/artwork/album?${params.toString()}`);
    const artwork = response.result || {};
    if (!artwork.coverImage && !artwork.thumb) return;
    const fields = {
      coverImage: artwork.coverImage || artwork.thumb,
      thumb: artwork.thumb || artwork.coverImage,
      artworkProvider: artwork.artworkProvider || '',
    };
    for (const item of collectionReleases) {
      if (String(item.id) === String(release.id)) Object.assign(item, fields);
    }
    Object.assign(release, fields);
    if (activeRelease && String(activeRelease.id) === String(release.id)) {
      Object.assign(activeRelease, fields);
      const detailCover = libraryUi.releasePanel.querySelector('.release-cover');
      if (detailCover) imageInCover(detailCover, fields.coverImage, `${release.title} cover`);
    }
    applyArtworkToCard(release);
  } catch (_) {
    // Missing artwork or a temporary external-service outage should not disturb browsing.
  }
}

function queueArtworkLookup(release) {
  if (!release || release.thumb || release.coverImage || artworkAttempted.has(String(release.id))) return;
  artworkAttempted.add(String(release.id));
  artworkQueue.push(release);
  runArtworkQueue();
}

function runArtworkQueue() {
  while (artworkRequestsActive < MAX_ARTWORK_REQUESTS && artworkQueue.length) {
    const release = artworkQueue.shift();
    artworkRequestsActive += 1;
    lookupArtwork(release).finally(() => {
      artworkRequestsActive -= 1;
      runArtworkQueue();
    });
  }
}

if ('IntersectionObserver' in window) {
  artworkObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      artworkObserver.unobserve(entry.target);
      const id = entry.target.dataset.releaseId;
      const release = collectionReleases.find((candidate) => String(candidate.id) === String(id));
      if (release) queueArtworkLookup(release);
    }
  }, { root: libraryUi.grid, rootMargin: '100px' });
}

function renderCollection() {
  const query = String(libraryUi.search.value || '').trim().toLocaleLowerCase();
  const rows = collectionReleases.filter((release) =>
    `${release.title} ${release.artistText} ${release.year} ${(release.labels || []).join(' ')}`.toLocaleLowerCase().includes(query));
  libraryUi.grid.replaceChildren();
  libraryUi.count.textContent = collectionReleases.length ? `${rows.length.toLocaleString()} / ${collectionReleases.length.toLocaleString()} ALBUMS` : 'NO RELEASES';
  if (!collectionReleases.length) return;
  if (!rows.length) {
    libraryUi.status.textContent = 'No records match that search.';
    return;
  }
  libraryUi.status.textContent = collectionSource === 'discogs'
    ? `Showing ${rows.length.toLocaleString()} album${rows.length === 1 ? '' : 's'} from @${settingsStatus.discogsUsername || 'your Discogs collection'}. Select an album to view its cover art and details.`
    : `Showing ${rows.length.toLocaleString()} album${rows.length === 1 ? '' : 's'} from your local CSV library. Select an album to view its cover art and details.`;
  const fragment = document.createDocumentFragment();
  for (const release of rows) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `album-card${activeRelease?.id === release.id ? ' selected' : ''}`;
    card.dataset.releaseId = String(release.id);
    card.setAttribute('aria-label', `Open ${release.title} by ${release.artistText}`);
    const cover = textElement('div', 'album-cover');
    const coverUrl = release.thumb || release.coverImage;
    if (coverUrl) imageInCover(cover, coverUrl, `${release.title} cover`);
    else cover.appendChild(textElement('span', 'album-cover-fallback', '◉'));
    const body = textElement('div', 'album-card-body');
    body.appendChild(textElement('div', 'album-card-title', release.title));
    body.appendChild(textElement('div', 'album-card-artist', release.artistText));
    const meta = textElement('div', 'album-card-meta');
    meta.appendChild(textElement('span', '', release.year || 'YEAR —'));
    meta.appendChild(textElement('span', '', (release.formats || [])[0] || 'RELEASE'));
    body.appendChild(meta);
    card.append(cover, body);
    card.addEventListener('click', () => openRelease(release));
    fragment.appendChild(card);
  }
  libraryUi.grid.appendChild(fragment);
  if (artworkObserver) {
    for (const card of libraryUi.grid.querySelectorAll('.album-card')) {
      const release = rows.find((candidate) => String(candidate.id) === card.dataset.releaseId);
      if (release && !release.thumb && !release.coverImage) artworkObserver.observe(card);
    }
  } else {
    for (const release of rows.slice(0, 30)) queueArtworkLookup(release);
  }
}

function renderReleaseEmpty(message = 'Select an album to view its cover art and mark it as playing.') {
  libraryUi.releasePanel.replaceChildren();
  const empty = textElement('div', 'release-empty');
  empty.appendChild(textElement('div', 'empty-record', '◉'));
  empty.appendChild(textElement('div', 'empty-title', 'Select an album'));
  empty.appendChild(textElement('p', '', message));
  libraryUi.releasePanel.appendChild(empty);
}

function renderSelectedTrack(selection) {
  if (!selection) {
    libraryUi.selectedStrip.hidden = true;
    return;
  }
  libraryUi.selectedStrip.hidden = false;
  libraryUi.selectedTitle.textContent = selection.releaseTitle;
  libraryUi.selectedRelease.textContent = selection.artist || 'Album selected';
}

async function markAlbumAsPlaying(release) {
  if (!release) return;
  try {
    const result = await post('/api/selection', { release });
    renderSelectedTrack(result.selection);
    const markButton = libraryUi.releasePanel.querySelector('.mark-playing-button');
    if (markButton) markButton.textContent = '✓ Album marked as playing';
    ui.notice.querySelector('p').textContent = 'Now Playing shows the selected album and artist. The broadcast remains your live turntable input.';
  } catch (error) { showError(error.message); }
}

function renderAlbumHeader(root, release) {
  const header = textElement('div', 'release-detail-header');
  const cover = textElement('div', 'release-cover');
  const imageUrl = release.coverImage || release.thumb;
  if (imageUrl) imageInCover(cover, imageUrl, `${release.title} cover`);
  else cover.appendChild(textElement('span', '', '◉'));
  const meta = textElement('div', 'release-meta');
  meta.appendChild(textElement('div', 'release-title', release.title));
  meta.appendChild(textElement('div', 'release-artist', release.artistText || release.artists?.join?.(', ') || 'Unknown artist'));
  const facts = [release.year, ...(release.labels || []).slice(0, 2), ...(release.formats || []).slice(0, 1), release.catalogNumber ? `Cat. ${release.catalogNumber}` : ''].filter(Boolean).join(' · ');
  meta.appendChild(textElement('div', 'release-facts', facts || (release.source === 'csv' ? 'Local CSV library' : 'Discogs release')));
  if (release.uri && /^https:\/\/(www\.)?discogs\.com\//i.test(release.uri)) {
    const link = document.createElement('a');
    link.className = 'release-discogs-link';
    link.href = release.uri;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'View release on Discogs ↗';
    meta.appendChild(link);
  }
  header.append(cover, meta);
  root.appendChild(header);
}

async function openRelease(release) {
  activeRelease = release;
  renderCollection();
  libraryUi.releasePanel.replaceChildren(textElement('div', 'release-empty', 'Loading album details…'));
  try {
    let result;
    if (release.source === 'csv') result = await request(`/api/library/releases/${encodeURIComponent(release.id)}`);
    else result = await request(`/api/discogs/releases/${encodeURIComponent(release.id)}`);
    const fetchedRelease = result.release || result;
    activeRelease = { ...release, ...fetchedRelease, id: release.id, source: release.source || 'discogs', artistText: release.artistText || fetchedRelease.artistText || (fetchedRelease.artists || []).join(', ') };
    if (activeRelease.coverImage || activeRelease.thumb) {
      for (const item of collectionReleases) {
        if (String(item.id) === String(release.id)) Object.assign(item, {
          coverImage: activeRelease.coverImage || activeRelease.thumb,
          thumb: activeRelease.thumb || activeRelease.coverImage,
          artworkProvider: activeRelease.artworkProvider || item.artworkProvider || '',
        });
      }
      applyArtworkToCard(activeRelease);
    }
    if (!activeRelease.coverImage && !activeRelease.thumb) {
      try {
        const params = new URLSearchParams({
          title: activeRelease.title || '',
          artist: activeRelease.artistText || '',
          year: activeRelease.year || '',
        });
        if (activeRelease.discogsId || release.source === 'discogs') params.set('discogsId', String(activeRelease.discogsId || release.id));
        if (release.source === 'csv') params.set('localReleaseId', String(release.id));
        const artworkResponse = await request(`/api/artwork/album?${params.toString()}`);
        const artwork = artworkResponse.result || {};
        activeRelease = { ...activeRelease, ...artwork, id: release.id, source: release.source || 'discogs' };
      } catch (_) { /* Artwork is optional; albums remain selectable when a lookup fails. */ }
    }
    const root = libraryUi.releasePanel;
    root.replaceChildren();
    renderAlbumHeader(root, activeRelease);
    const artworkNote = textElement('p', 'album-artwork-note', activeRelease.coverImage || activeRelease.thumb
      ? `Cover art${activeRelease.artworkProvider ? ` via ${activeRelease.artworkProvider}` : ''}. Album selection only; audio remains live from your turntable.`
      : 'No cover was found automatically. You can still select this album.');
    root.appendChild(artworkNote);
    const markButton = textElement('button', 'mark-playing-button', '♫ Set this album as Now Playing');
    markButton.type = 'button';
    markButton.addEventListener('click', () => markAlbumAsPlaying(activeRelease));
    root.appendChild(markButton);
  } catch (error) {
    if (release.source === 'csv') {
      renderReleaseEmpty(error.message || 'Could not load this local album.');
    } else renderReleaseEmpty(error.message || 'Could not load this album.');
    showError(error.message);
  }
}

async function refreshCollection(force = false, sourceOverride = null) {
  const requestedSource = sourceOverride || collectionSource;
  if (requestedSource === 'discogs' && !settingsStatus.discogsConfigured) { showError('Discogs is optional. Connect it in Settings or use a local CSV import.'); return; }
  libraryUi.refresh.disabled = requestedSource === 'discogs';
  libraryUi.local.disabled = requestedSource === 'local';
  try {
    if (requestedSource === 'discogs' && settingsStatus.discogsConfigured) {
      libraryUi.status.textContent = force ? 'Syncing the Discogs collection…' : 'Loading cached Discogs collection…';
      const result = await request(`/api/discogs/collection${force ? '?refresh=true' : ''}`);
      collectionReleases = (result.releases || []).map((release) => ({ ...release, source: 'discogs' }));
      collectionSource = 'discogs';
      libraryUi.count.textContent = `${collectionReleases.length.toLocaleString()} DISCOGS ALBUMS`;
      libraryUi.status.textContent = `Loaded ${result.count.toLocaleString()} records from Discogs.`;
    } else {
      libraryUi.status.textContent = 'Loading your local collection…';
      const result = await request('/api/library/collection');
      collectionReleases = (result.releases || []).map((release) => ({ ...release, source: 'csv' }));
      collectionSource = 'local';
      libraryUi.count.textContent = `${collectionReleases.length.toLocaleString()} LOCAL ALBUMS`;
      libraryUi.status.textContent = collectionReleases.length
        ? `Loaded ${collectionReleases.length.toLocaleString()} albums from ${result.filename || 'your local CSV'}.`
        : 'No local library yet. Import a Discogs collection CSV, connect Discogs in Settings, or use Manual entry without a library.';
    }
    renderCollection();
    if (!activeRelease || !collectionReleases.some((release) => release.id === activeRelease.id)) renderReleaseEmpty();
  } catch (error) {
    collectionReleases = [];
    libraryUi.grid.replaceChildren();
    libraryUi.count.textContent = 'LIBRARY ERROR';
    libraryUi.status.textContent = error.message || 'Could not load your library.';
    showError(error.message);
  } finally {
    libraryUi.refresh.disabled = !settingsStatus.discogsConfigured;
    libraryUi.local.disabled = false;
  }
}

async function importCsvFile(file) {
  if (!file) return;
  libraryUi.import.disabled = true;
  libraryUi.status.textContent = `Importing ${file.name}…`;
  showError('');
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a CSV file that is 10 MB or smaller.');
    const csv = await file.text();
    const result = await post('/api/library/import-csv', { filename: file.name, csv });
    collectionReleases = (result.releases || []).map((release) => ({ ...release, source: 'csv' }));
    collectionSource = 'local';
    activeRelease = null;
      libraryUi.status.textContent = `Imported ${result.count.toLocaleString()} albums from ${result.filename}. Album artwork will be looked up automatically where available.`;
    renderCollection();
    renderReleaseEmpty('Select an album to view its metadata and mark it as playing.');
    libraryUi.count.textContent = `${result.count.toLocaleString()} LOCAL ALBUMS`;
    ui.notice.querySelector('p').textContent = 'Your collection is stored locally. Needlecast looks for exact Discogs covers when connected and otherwise searches album artwork automatically.';
  } catch (error) {
    showError(error.message);
    libraryUi.status.textContent = error.message || 'Could not import this CSV.';
  } finally {
    libraryUi.import.disabled = false;
    libraryUi.file.value = '';
  }
}

async function submitManualTrack(event) {
  event.preventDefault();
  const artist = manualUi.artist.value.trim();
  const album = manualUi.album.value.trim();
  if (!album) { manualUi.message.textContent = 'Enter an album title.'; return; }
  manualUi.message.textContent = 'Updating Now Playing…';
  try {
    const release = { id: `manual-${Date.now()}`, source: 'manual', title: album, artistText: artist, artists: artist ? [artist] : [] };
    try {
      const params = new URLSearchParams({ title: album, artist });
      const response = await request(`/api/artwork/album?${params.toString()}`);
      const artwork = response.result || {};
      if (artwork.matched) Object.assign(release, artwork, { id: release.id, source: 'manual' });
    } catch (_) { /* Manual album selection must work without external services. */ }
    const result = await post('/api/selection', { release });
    renderSelectedTrack(result.selection);
    manualUi.message.textContent = 'Now Playing updated.';
    manualUi.dialog.close();
    ui.notice.querySelector('p').textContent = 'Manual album metadata is set. The audio broadcast remains the live input from your turntable.';
  } catch (error) { manualUi.message.textContent = error.message || 'Could not update Now Playing.'; }
}

async function loadSettingsAndRuntimeStatuses() {
  await refreshSettingsStatus();
  if (settingsStatus.discordConfigured && !backendStatus.botReady) await refreshChannels();
}

let gainTimer;
ui.gain.addEventListener('input', () => {
  ui.gainValue.textContent = formatDb(ui.gain.value);
  window.clearTimeout(gainTimer);
  gainTimer = window.setTimeout(async () => {
    if (!agentOnline) return;
    try { await post(`${AGENT}/api/gain`, { gainDb: Number(ui.gain.value) }); } catch (_) { /* visible on next status poll */ }
  }, 150);
});

[ui.bass, ui.mid, ui.treble, ui.rumbleFilter, ui.humFilter, ui.limiter].forEach((control) => {
  control.addEventListener('input', scheduleAudioProcessingUpdate);
  control.addEventListener('change', scheduleAudioProcessingUpdate);
});
ui.eqPresets.forEach((button) => {
  button.addEventListener('click', () => {
    const preset = EQ_PRESETS[button.dataset.eqPreset];
    if (!preset) return;
    setAudioProcessingControls(preset.config);
    scheduleAudioProcessingUpdate();
  });
});
ui.refreshDevices.addEventListener('click', refreshDevices);
ui.refreshChannels.addEventListener('click', refreshChannels);
ui.start.addEventListener('click', startBroadcast);
ui.stop.addEventListener('click', stopBroadcast);
libraryUi.refresh.addEventListener('click', () => refreshCollection(true, 'discogs'));
libraryUi.local.addEventListener('click', () => refreshCollection(false, 'local'));
libraryUi.import.addEventListener('click', () => libraryUi.file.click());
libraryUi.file.addEventListener('change', () => importCsvFile(libraryUi.file.files?.[0]));
libraryUi.manual.addEventListener('click', () => { manualUi.message.textContent = 'Manual entry works without Discogs.'; manualUi.dialog.showModal(); });
libraryUi.search.addEventListener('input', renderCollection);
manualUi.close.addEventListener('click', () => manualUi.dialog.close());
manualUi.form.addEventListener('submit', submitManualTrack);
settingsUi.open.addEventListener('click', openSettings);
settingsUi.close.addEventListener('click', () => settingsUi.dialog.close());
settingsUi.form.addEventListener('submit', saveSettings);
settingsUi.clearDiscord.addEventListener('change', () => {
  if (settingsUi.clearDiscord.checked) { settingsUi.discordToken.value = ''; settingsUi.guildId.value = ''; }
});
settingsUi.clearDiscogs.addEventListener('change', () => {
  if (settingsUi.clearDiscogs.checked) { settingsUi.discogsToken.value = ''; settingsUi.discogsUsername.value = ''; }
});

(async function init() {
  ui.gainValue.textContent = formatDb(ui.gain.value);
  restoreAudioProcessingPreferences();
  try {
    const config = await request('/api/config');
    if (config.captureAgentBase) AGENT = config.captureAgentBase;
  } catch (_) { /* useful errors are shown by the service checks below */ }
  await refreshSettingsStatus();
  try {
    const localLibrary = await request('/api/library/collection');
    collectionSource = localLibrary.count > 0 ? 'local' : (settingsStatus.discogsConfigured ? 'discogs' : 'local');
  } catch (_) { collectionSource = settingsStatus.discogsConfigured ? 'discogs' : 'local'; }
  await Promise.all([refreshDevices(), refreshChannels(), refreshCollection(false, collectionSource), loadSettingsAndRuntimeStatuses()]);
  await syncAudioProcessingToAgent();
  try {
    const savedSelection = await request('/api/selection');
    if (savedSelection.selection) renderSelectedTrack(savedSelection.selection);
  } catch (_) { /* optional metadata */ }
  await refreshStatus();
  if (window.needlecast?.getAppInfo) {
    try {
      const info = await window.needlecast.getAppInfo();
      const version = document.querySelector('.version');
      if (version) version.textContent = `v${info.version} · ${info.packaged ? 'desktop' : 'dev build'}`;
    } catch (_) { /* optional */ }
    if (!settingsStatus.discordConfigured) openSettings();
  }
  window.setInterval(refreshStatus, 1000);
  window.setInterval(() => {
    if (backendStatus.botReady && !ui.channel.options.length) refreshChannels();
  }, 5000);
})();
