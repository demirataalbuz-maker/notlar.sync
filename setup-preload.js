'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', Object.freeze({
  platform: process.platform,
  status: () => ipcRenderer.invoke('setup:status'),
  patchConfig: (patch) => ipcRenderer.invoke('setup:patch-config', patch),
  done: () => ipcRenderer.send('setup-done'),
  pairClaim: (data) => ipcRenderer.invoke('setup:pair-claim', data),
  pairApprove: (data) => ipcRenderer.invoke('setup:pair-approve', data),
  pairStatus: (data) => ipcRenderer.invoke('setup:pair-status', data),
  openUrl: (url) => ipcRenderer.invoke('setup:open-url', url),
  installTailscale: () => ipcRenderer.invoke('setup:install-tailscale'),
  tailscaleUp: () => ipcRenderer.invoke('setup:tailscale-up'),
  onLoginUrl: (callback) => {
    ipcRenderer.on('setup:login-url', (_event, url) => callback(url));
  },
}));
