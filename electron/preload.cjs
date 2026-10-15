// Arayüze (renderer) açılan güvenli köprü: window.tune
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'player:state',
  'player:ended',
  'player:error',
  'player:media',
  'player:debug',
  'auth:changed',
]);

contextBridge.exposeInMainWorld('tune', {
  platform: process.platform,
  ready: () => ipcRenderer.invoke('ytm:ready'),
  ytm: (method, ...args) => ipcRenderer.invoke('ytm:call', method, args),
  auth: {
    login: () => ipcRenderer.invoke('auth:login'),
    loginWithCookie: (cookie) => ipcRenderer.invoke('auth:cookie', cookie),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  player: {
    load: (track) => ipcRenderer.invoke('player:load', track),
    cmd: (cmd, arg) => ipcRenderer.send('player:cmd', cmd, arg),
    debug: (show) => ipcRenderer.send('player:debug', show),
  },
  color: (url) => ipcRenderer.invoke('img:color', url),
  setThumbar: (playing) => ipcRenderer.send('app:thumbar', playing),
  setTitle: (title) => ipcRenderer.send('app:title', title),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  on: (channel, cb) => {
    if (!CHANNELS.has(channel)) throw new Error('İzin verilmeyen kanal: ' + channel);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
