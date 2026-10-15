'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const APP_NAME = 'Needlecast';
const APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '..', 'build-resources', 'icon.ico');
const SETTINGS_FILE = 'credentials.dat';
let mainWindow = null;
let agentProcess = null;
let agentLogStream = null;
let shuttingDown = false;
let webPort = null;
let agentPort = null;
let backendOrigin = null;

app.setName(APP_NAME);
app.setAppUserModelId('com.needlecast.desktop');

async function findFreePort(excludedPorts = new Set()) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const chosen = server.address().port;
        server.close((error) => error ? reject(error) : resolve(chosen));
      });
    });
    if (!excludedPorts.has(port)) return port;
  }
  throw new Error('Could not reserve distinct local ports for Needlecast.');
}

function credentialsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function defaultSettings() {
  return { discordToken: '', guildId: '', discogsUsername: '', discogsToken: '', botPresenceEnabled: true, clearPresenceOnStop: true, botAvatarFromAlbum: true };
}

function validateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings payload is invalid.');
  const settings = {
    discordToken: String(raw.discordToken || '').trim(),
    guildId: String(raw.guildId || '').trim(),
    discogsUsername: String(raw.discogsUsername || '').trim(),
    discogsToken: String(raw.discogsToken || '').trim(),
    botPresenceEnabled: raw.botPresenceEnabled !== false,
    clearPresenceOnStop: raw.clearPresenceOnStop !== false,
    botAvatarFromAlbum: raw.botAvatarFromAlbum !== false,
  };
  if (settings.discordToken.length > 512 || settings.discogsToken.length > 512) throw new Error('A token is too long. Check that you pasted the token correctly.');
  if (settings.guildId && !/^\d{15,25}$/.test(settings.guildId)) throw new Error('Discord Server ID should be a 15–25 digit snowflake ID.');
  if (Boolean(settings.discordToken) !== Boolean(settings.guildId)) throw new Error('Enter both the Discord bot token and server ID, or leave both empty.');
  if (settings.discogsUsername.length > 100) throw new Error('Discogs username is too long.');
  if (Boolean(settings.discogsUsername) !== Boolean(settings.discogsToken)) throw new Error('Enter both the Discogs username and personal access token, or leave both empty.');
  return settings;
}

function loadCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return defaultSettings();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable. Needlecast will not read credentials from disk until secure storage is available.');
  }
  try {
    const encryptedBase64 = fs.readFileSync(file, 'utf8');
    const decrypted = safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
    const parsed = JSON.parse(decrypted);
    return validateSettings(parsed);
  } catch (error) {
    throw new Error(`Could not decrypt Needlecast credentials. The settings file may belong to another Windows user or be damaged. Use Settings recovery after backing up ${file}. Details: ${error.message}`);
  }
}

function saveCredentials(settings) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable; credentials were not saved.');
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const encrypted = safeStorage.encryptString(JSON.stringify(settings)).toString('base64');
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, encrypted, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function applySettingsToEnvironment(settings) {
  // Clear ambient shell vars and .env fallbacks: a packaged desktop app reads credentials
  // only from the OS-protected store. The Docker/dev CLI path still supports .env.
  process.env.DESKTOP_MODE = '1';
  process.env.DISCORD_TOKEN = settings.discordToken;
  process.env.GUILD_ID = settings.guildId;
  process.env.DISCOGS_USERNAME = settings.discogsUsername;
  process.env.DISCOGS_TOKEN = settings.discogsToken;
  process.env.NEEDLECAST_BOT_PRESENCE = settings.botPresenceEnabled ? '1' : '0';
  process.env.NEEDLECAST_CLEAR_PRESENCE_ON_STOP = settings.clearPresenceOnStop ? '1' : '0';
  process.env.NEEDLECAST_BOT_AVATAR_FROM_ALBUM = settings.botAvatarFromAlbum ? '1' : '0';
  process.env.NEEDLECAST_DATA_DIR = app.getPath('userData');
  process.env.CAPTURE_AGENT_PORT = String(agentPort);
  process.env.CAPTURE_AGENT_ORIGIN = `http://127.0.0.1:${webPort}`;
  process.env.PORT = String(webPort);
  process.env.AUDIO_WS_PORT = process.env.NEEDLECAST_AUDIO_PORT;
}

function appendAgentLog(chunk) {
  if (agentLogStream) agentLogStream.write(chunk);
}

function startCaptureAgent() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'capture-agent.log');
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      const previous = `${logFile}.1`;
      if (fs.existsSync(previous)) fs.unlinkSync(previous);
      fs.renameSync(logFile, previous);
    }
  } catch (_) { /* log rotation is best-effort */ }
  agentLogStream = fs.createWriteStream(logFile, { flags: 'a' });
  // Audio capture does not need Discord/Discogs credentials, so pass it a minimal
  // operating-system environment instead of inheriting the backend's secret variables.
  const env = {};
  const allowedEnvironment = [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'HOME', 'TMPDIR', 'LANG', 'PYTHONUTF8', 'PYTHONPATH', 'VIRTUAL_ENV',
  ];
  for (const key of allowedEnvironment) if (process.env[key]) env[key] = process.env[key];
  env.CAPTURE_AGENT_PORT = String(agentPort);
  env.AUDIO_WS_URL = `ws://127.0.0.1:${process.env.NEEDLECAST_AUDIO_PORT}/audio`;
  env.ALLOWED_ORIGIN = backendOrigin;

  if (app.isPackaged) {
    const executable = path.join(process.resourcesPath, 'capture-agent', 'needlecast-capture-agent.exe');
    if (!fs.existsSync(executable)) {
      appendAgentLog(`Capture agent executable is missing: ${executable}\nBuild it with npm run build:capture-agent before packaging.\n`);
      return;
    }
    agentProcess = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const scriptDir = path.join(__dirname, '..', 'capture-agent');
    const isWindows = process.platform === 'win32';
    const python = process.env.NEEDLECAST_PYTHON || (isWindows ? 'py' : 'python3');
    const args = isWindows
      ? ['-3', '-m', 'uvicorn', 'capture_agent:app', '--host', '127.0.0.1', '--port', String(agentPort)]
      : ['-m', 'uvicorn', 'capture_agent:app', '--host', '127.0.0.1', '--port', String(agentPort)];
    agentProcess = spawn(python, args, { cwd: scriptDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  agentProcess.stdout?.on('data', appendAgentLog);
  agentProcess.stderr?.on('data', appendAgentLog);
  agentProcess.on('error', (error) => appendAgentLog(`Could not start capture agent: ${error.message}\n`));
  agentProcess.on('exit', (code, signal) => {
    appendAgentLog(`Capture agent exited (code=${code}, signal=${signal}).\n`);
    agentProcess = null;
  });
}

async function stopCaptureAgent() {
  if (agentProcess && !agentProcess.killed) {
    const child = agentProcess;
    try { child.kill(); } catch (_) { /* process already exited */ }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1500);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    agentProcess = null;
  }
  if (agentLogStream) {
    await new Promise((resolve) => agentLogStream.end(resolve));
    agentLogStream = null;
  }
}

async function waitForBackend(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (_) { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Needlecast local backend did not start. Check the application logs.');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#111318',
    title: APP_NAME,
    icon: fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      const allowedHosts = new Set(['discord.com', 'www.discogs.com', 'discogs.com']);
      if (parsed.protocol === 'https:' && allowedHosts.has(parsed.hostname)) shell.openExternal(parsed.href);
    } catch (_) { /* invalid or untrusted URLs are denied */ }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${backendOrigin}/`)) event.preventDefault();
  });
  mainWindow.loadURL(backendOrigin);
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('app:info', () => ({
  name: APP_NAME,
  version: app.getVersion(),
  platform: process.platform,
  packaged: app.isPackaged,
}));

ipcMain.handle('settings:save', async (event, rawSettings) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Settings can only be saved from the Needlecast window.');
  const senderUrl = event.senderFrame?.url || '';
  if (!backendOrigin || !senderUrl.startsWith(`${backendOrigin}/`)) throw new Error('Untrusted settings request was rejected.');
  const previous = loadCredentials();
  const incoming = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const settings = validateSettings({
    discordToken: incoming.clearDiscord ? '' : (String(incoming.discordToken || '').trim() || previous.discordToken),
    guildId: incoming.clearDiscord ? '' : (String(incoming.guildId || '').trim() || previous.guildId),
    discogsUsername: incoming.clearDiscogs ? '' : (String(incoming.discogsUsername || '').trim() || previous.discogsUsername),
    discogsToken: incoming.clearDiscogs ? '' : (String(incoming.discogsToken || '').trim() || previous.discogsToken),
    botPresenceEnabled: typeof incoming.botPresenceEnabled === 'boolean' ? incoming.botPresenceEnabled : previous.botPresenceEnabled,
    clearPresenceOnStop: typeof incoming.clearPresenceOnStop === 'boolean' ? incoming.clearPresenceOnStop : previous.clearPresenceOnStop,
    botAvatarFromAlbum: typeof incoming.botAvatarFromAlbum === 'boolean' ? incoming.botAvatarFromAlbum : previous.botAvatarFromAlbum,
  });
  saveCredentials(settings);
  setTimeout(() => {
    app.relaunch();
    app.quit();
  }, 700);
  return { ok: true, restarting: true };
});

app.whenReady().then(async () => {
  let settings;
  try {
    settings = loadCredentials();
  } catch (error) {
    dialog.showErrorBox('Needlecast settings could not be loaded', error.message);
    app.quit();
    return;
  }

  try {
    const usedPorts = new Set();
    webPort = await findFreePort(usedPorts);
    usedPorts.add(webPort);
    agentPort = await findFreePort(usedPorts);
    usedPorts.add(agentPort);
    process.env.NEEDLECAST_AUDIO_PORT = String(await findFreePort(usedPorts));
    backendOrigin = `http://127.0.0.1:${webPort}`;
    applySettingsToEnvironment(settings);
    // Require after configuration: server.js starts the API and Discord voice services.
    require('../server.js');
    await waitForBackend(backendOrigin);
    startCaptureAgent();
    createWindow();
  } catch (error) {
    dialog.showErrorBox('Needlecast could not start', `${error.message}\n\nCapture-agent logs, if available, are stored under ${path.join(app.getPath('userData'), 'logs')}.`);
    await stopCaptureAgent();
    try { await global.__needlecastShutdown?.(); } catch (_) { /* best effort */ }
    app.quit();
  }
});

let shutdownPromise = null;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  shutdownPromise = (async () => {
    try {
      if (backendOrigin) {
        await fetch(`${backendOrigin}/api/stream/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1000) }).catch(() => {});
        await fetch(`http://127.0.0.1:${agentPort}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1000) }).catch(() => {});
      }
      await stopCaptureAgent();
      await global.__needlecastShutdown?.();
    } finally {
      app.exit(0);
    }
  })();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendOrigin) createWindow();
});

process.on('uncaughtException', (error) => {
  const logDir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'application.log'), `${new Date().toISOString()} uncaught exception: ${error.stack || error.message}\n`);
  } catch (_) { /* preserve original error */ }
});
