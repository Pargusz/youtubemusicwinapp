// Gizli YouTube Music penceresine yüklenir. Sayfanın kendi "sonraki şarkı" mantığını
// devre dışı bırakır ve olayları ana sürece iletir.
const { ipcRenderer, contextBridge } = require('electron');

const isAd = () => Boolean(document.getElementById('movie_player')?.classList.contains('ad-showing'));

// Şarkı bittiğinde YouTube Music kendi kuyruğuna geçmesin; sırayı uygulama yönetir.
window.addEventListener(
  'ended',
  (e) => {
    if (!(e.target instanceof HTMLMediaElement) || isAd()) return;
    e.stopImmediatePropagation();
    ipcRenderer.send('player:ended');
  },
  true,
);

contextBridge.exposeInMainWorld('__tune', {
  media: (action) => ipcRenderer.send('player:media', action),
});

// Medya tuşları / Windows medya paneli (SMTC) uygulamanın kuyruğunu kullansın,
// ve kilit ekranında doğru şarkı bilgisi görünsün.
const mainWorldPatch = () => {
  if (window.__tunePatched || !navigator.mediaSession) return;
  window.__tunePatched = true;
  const ms = navigator.mediaSession;
  const orig = ms.setActionHandler.bind(ms);
  const ours = {
    nexttrack: () => window.__tune.media('next'),
    previoustrack: () => window.__tune.media('prev'),
  };
  ms.setActionHandler = (action, handler) => orig(action, ours[action] || handler);
  for (const a of Object.keys(ours)) {
    try {
      orig(a, ours[a]);
    } catch {}
  }
  const desc = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'metadata');
  if (desc?.set) {
    Object.defineProperty(ms, 'metadata', {
      configurable: true,
      get: () => desc.get.call(ms),
      set: (v) => {
        if (v && v.__tune) desc.set.call(ms, v);
      },
    });
    window.__tuneSetMeta = (m) => {
      const md = new MediaMetadata(m);
      md.__tune = true;
      desc.set.call(ms, md);
    };
  }
};

try {
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: mainWorldPatch });
} catch {}
window.addEventListener('DOMContentLoaded', () => {
  try {
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: mainWorldPatch });
  } catch {}
});

// "Hâlâ dinliyor musun?" penceresini kapat; atlanabilir reklamlarda "Reklamı atla"ya bas.
setInterval(() => {
  const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
  if (skip && skip.offsetParent !== null) skip.click();
  const dlg = document.querySelector('ytmusic-you-there-renderer');
  if (dlg && dlg.offsetParent !== null) {
    dlg.querySelector('button, yt-button-renderer, tp-yt-paper-button')?.click();
  }
}, 1000);
