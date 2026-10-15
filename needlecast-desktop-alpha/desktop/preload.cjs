'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Deliberately expose only a narrow capability. The renderer never receives Node.js,
// filesystem, shell, or raw Electron APIs.
contextBridge.exposeInMainWorld('needlecast', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
}));
