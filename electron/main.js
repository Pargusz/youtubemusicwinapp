import { app, BrowserWindow, ipcMain, session, shell, nativeImage, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ytm from './ytm.js';
import { Player } from './player.js';
import { findBrowser, loginWithBrowser, toElectronCookie } from './browser-login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTITION = 'persist:ytm';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

app.setName('Tını');
// TINI_PROFILE: geliştirme/test için ayrı bir veri klasörü (kullanıcının oturumuna dokunmadan)
app.setPath('userData', process.env.TINI_PROFILE || path.join(app.getPath('appData'), 'TiniMusic'));
if (isWin) app.setAppUserModelId('com.tini.music');

// Google girişinin gömülü tarayıcıyı reddetmemesi için "Electron" izini kullanıcı ajanından çıkar
app.userAgentFallback = app.userAgentFallback.replace(/\s?(Electron|Tını|Tini|ytmusic-desktop)\/\S+/gi, '');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.TINI_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.TINI_DEBUG_PORT);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let player = null;
let readyPromise = null;
let quitting = false;

const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

// ---------- oturum / çerezler ----------

const ytmSession = () => session.fromPartition(PARTITION);

// Giriş sorunlarını tahmin yürütmeden çözebilmek için kısa bir tanı günlüğü (userData/tini-log.txt).
// Yalnızca olay ve çerez ADLARI yazılır; çerez değerleri asla yazılmaz.
const AUTH_COOKIES = new Set([
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-1PSIDCC', '__Secure-3PSIDCC', 'SIDCC',
]);
function diag(...parts) {
  try {
    const file = path.join(app.getPath('userData'), 'tini-log.txt');
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {}
}

async function clearAuthCookies() {
  for (const c of await ytmSession().cookies.get({})) {
    if (!AUTH_COOKIES.has(c.name)) continue;
    const host = c.domain.replace(/^\./, '');
    await ytmSession().cookies.remove(`https://${host}${c.path || '/'}`, c.name).catch(() => {});
  }
  await ytmSession().cookies.flushStore().catch(() => {});
}

async function cookieHeader() {
  const cookies = await ytmSession().cookies.get({ domain: 'youtube.com' });
  if (!cookies.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) return null;
  const seen = new Set();
  return cookies
    .filter((c) => (seen.has(c.name) ? false : seen.add(c.name)))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// Arayüz Türkçe olduğu için YouTube Music içeriği de Türkçe/Türkiye olarak istenir.
// Farklı bölge için: TINI_LANG=en TINI_REGION=US
function locale() {
  return { lang: process.env.TINI_LANG || 'tr', location: process.env.TINI_REGION || 'TR' };
}

async function initYtm() {
  const cookie = await cookieHeader();
  try {
    const res = await ytm.init({ cookie, ...locale() });
    diag('init', 'cookie=' + Boolean(cookie), 'loggedIn=' + res.loggedIn, res.invalidSession ? 'GECERSIZ_OTURUM' : '');
    return res;
  } catch (err) {
    diag('init HATA', err.message);
    console.error('[ytm] başlatılamadı, misafir modunda deneniyor:', err.message);
    return ytm.init(locale());
  }
}

async function reinit() {
  readyPromise = initYtm();
  await readyPromise;
  await player?.resetSession();
  send('auth:changed', await ytm.account());
}

const LOGIN_URL =
  'https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&passive=true&hl=tr&continue=' +
  encodeURIComponent('https://music.youtube.com/');

// Giriş, uygulamaya ait ayrı bir tarayıcı profilinde yapılır; çıkışta bu profil de silinir
const loginProfileDir = () => path.join(app.getPath('userData'), 'login-browser');
let browserLoginActive = null;

// Google, uygulama içine gömülü tarayıcıları ve eski Chromium sürümlerini ("Bu tarayıcı veya
// uygulama güvenli olmayabilir") reddediyor. Electron'un Chromium'u her zaman güncel Chrome'un
// gerisinde kaldığı için asıl yöntem: bilgisayardaki gerçek Chrome/Edge'de giriş yaptırıp
// oturum çerezlerini uygulamaya aktarmak (bkz. browser-login.js).
async function login() {
  const browser = findBrowser();
  if (!browser) return openLoginWindow();
  if (browserLoginActive) return browserLoginActive;
  browserLoginActive = (async () => {
    diag('login basladi', browser.name);
    const cookies = await loginWithBrowser({ exe: browser.exe, profileDir: loginProfileDir(), url: LOGIN_URL });
    if (!cookies) {
      diag('login iptal/tamamlanmadi');
      return false;
    }
    diag(
      'login cerezler',
      cookies.length,
      cookies.filter((c) => AUTH_COOKIES.has(c.name)).map((c) => `${c.domain}:${c.name}${c.session ? '(oturumluk)' : ''}`).join(','),
    );
    for (const c of cookies) {
      try {
        await ytmSession().cookies.set(toElectronCookie(c));
      } catch (err) {
        diag('cerez aktarilamadi', c.name, err.message);
      }
    }
    await ytmSession().cookies.flushStore();
    await reinit();
    diag('login sonuc loggedIn=' + ytm.isLoggedIn());
    // Aynı Google oturumu iki ayrı istemcide (giriş tarayıcısı + uygulama) yaşayıp ayrı ayrı
    // yenilenirse Google bunu çalınmış oturum sayıp kapatabiliyor. Oturum artık yalnızca
    // uygulamada kalsın: giriş profilini sil.
    await removeLoginProfile();
    if (!ytm.isLoggedIn()) {
      await clearAuthCookies();
      throw new Error('Google oturumu doğrulanamadı. Lütfen tekrar dene; sorun sürerse tini-log.txt dosyasını paylaş.');
    }
    mainWindow?.show();
    mainWindow?.focus();
    return true;
  })().finally(() => {
    browserLoginActive = null;
  });
  return browserLoginActive;
}

// Windows'ta kapanmakta olan tarayıcı dosyaları birkaç saniye kilitli tutabiliyor; tekrar dene ve doğrula
async function removeLoginProfile() {
  const dir = loginProfileDir();
  for (let i = 0; i < 10 && fs.existsSync(dir); i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {}
    if (fs.existsSync(dir)) await new Promise((r) => setTimeout(r, 500));
  }
  if (fs.existsSync(dir)) diag('giris profili silinemedi');
}

// Yedek: bilgisayarda desteklenen bir tarayıcı yoksa uygulama içi pencere
function openLoginWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 500,
      height: 720,
      parent: mainWindow ?? undefined,
      title: 'Google hesabıyla giriş yap',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = async () => {
      if (done) return;
      const cookie = await cookieHeader();
      if (!cookie || done) return;
      done = true;
      ytmSession().cookies.removeListener('changed', onCookie);
      if (!win.isDestroyed()) win.close();
      await reinit();
      resolve(true);
    };
    const check = (url) => {
      // Google girişten sonra youtube.com veya music.youtube.com'a yönlendirir
      if (/^https:\/\/([a-z]+\.)?youtube\.com/.test(url)) finish();
    };
    // Yönlendirme yakalanamasa bile oturum çerezi gelince girişi tamamla
    const onCookie = (_e, cookie, _cause, removed) => {
      if (!removed && /youtube\.com$/.test(cookie.domain) && /^(SAPISID|__Secure-3PAPISID)$/.test(cookie.name)) {
        setTimeout(finish, 1500);
      }
    };
    ytmSession().cookies.on('changed', onCookie);
    win.webContents.on('did-navigate', (_e, url) => check(url));
    win.webContents.on('did-navigate-in-page', (_e, url) => check(url));
    win.webContents.setWindowOpenHandler(({ url }) => {
      win.loadURL(url);
      return { action: 'deny' };
    });
    win.on('closed', () => {
      ytmSession().cookies.removeListener('changed', onCookie);
      if (!done) resolve(false);
    });
    win.loadURL(LOGIN_URL);
  });
}

// Tarayıcıdan kopyalanan "Cookie" başlığıyla giriş (yedek yöntem)
async function loginWithCookie(raw) {
  const text = String(raw || '').replace(/^cookie:\s*/i, '').trim();
  const pairs = text
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : null;
    })
    .filter(Boolean);
  if (!pairs.some(([n]) => n === 'SAPISID' || n === '__Secure-3PAPISID')) {
    throw new Error('Çerezde SAPISID bulunamadı. music.youtube.com isteğinin tam Cookie başlığını yapıştır.');
  }
  const expirationDate = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  for (const [name, value] of pairs) {
    await ytmSession().cookies.set({
      url: 'https://music.youtube.com',
      domain: '.youtube.com',
      path: '/',
      name,
      value,
      secure: true,
      httpOnly: name.startsWith('__Secure') || name === 'SID' || name === 'HSID',
      sameSite: 'no_restriction',
      expirationDate,
    });
  }
  await reinit();
  return ytm.account();
}

async function logout() {
  await ytmSession().clearStorageData();
  // giriş tarayıcısının profilinde de oturum kalmasın
  await removeLoginProfile();
  await reinit();
  return { loggedIn: false };
}

// ---------- kapak renginden arka plan rengi ----------

const colorCache = new Map();

async function dominantColor(url) {
  if (!url) return null;
  if (colorCache.has(url)) return colorCache.get(url);
  try {
    const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/png,*/*;q=0.5' } });
    const buf = Buffer.from(await res.arrayBuffer());
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const bmp = img.resize({ width: 24, height: 24, quality: 'good' }).toBitmap(); // BGRA
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const B = bmp[i], G = bmp[i + 1], R = bmp[i + 2];
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = (max + min) / 510;
      // canlı ve orta parlaklıktaki pikselleri öne çıkar
      const weight = 0.08 + sat * sat * (1 - Math.abs(lum - 0.5) * 1.4);
      r += R * weight; g += G * weight; b += B * weight; w += weight;
    }
    const hex = '#' + [r, g, b].map((v) => Math.round(v / w).toString(16).padStart(2, '0')).join('');
    colorCache.set(url, hex);
    return hex;
  } catch {
    return null;
  }
}

// ---------- pencere ----------

function createMainWindow() {
  const iconPath = path.join(__dirname, '../assets/icon.png');
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 940,
    minHeight: 600,
    title: 'Tını',
    show: false,
    backgroundColor: '#000000',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 20, y: 22 } }
      : { titleBarOverlay: { color: '#000000', symbolColor: '#b3b3b3', height: 64 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    e.preventDefault();
  });

  // macOS'ta pencereyi kapatmak müziği durdurmaz (Spotify gibi); Dock simgesiyle geri gelir
  mainWindow.on('close', (e) => {
    if (isMac && !quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // gizli oynatıcı penceresi açık kaldığı için uygulamayı açıkça kapat
    if (!isMac) app.quit();
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}

// Windows görev çubuğu önizlemesindeki önceki / oynat / sonraki düğmeleri
function thumbarIcon(name) {
  const p = path.join(__dirname, '../assets/thumbar', `${name}.png`);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : null;
}

function updateThumbar(playing) {
  if (!isWin || !mainWindow) return;
  const icons = { prev: thumbarIcon('prev'), play: thumbarIcon('play'), pause: thumbarIcon('pause'), next: thumbarIcon('next') };
  if (!icons.prev || !icons.play || !icons.pause || !icons.next) return;
  mainWindow.setThumbarButtons([
    { tooltip: 'Önceki', icon: icons.prev, click: () => send('player:media', 'prev') },
    {
      tooltip: playing ? 'Duraklat' : 'Oynat',
      icon: playing ? icons.pause : icons.play,
      click: () => send('player:media', 'toggle'),
    },
    { tooltip: 'Sonraki', icon: icons.next, click: () => send('player:media', 'next') },
  ]);
}

// ---------- IPC ----------

const YTM_METHODS = new Set([
  'home', 'search', 'suggestions', 'playlist', 'album', 'artist', 'browse', 'moods', 'upNext', 'lyrics',
  'libraryPlaylists', 'libraryAlbums', 'libraryArtists', 'likedIds', 'rate', 'addToPlaylist',
  'removeFromPlaylist', 'createPlaylist', 'deletePlaylist', 'savePlaylist', 'account',
]);

function registerIpc() {
  ipcMain.handle('ytm:ready', async () => {
    await readyPromise;
    return ytm.account();
  });
  ipcMain.handle('ytm:call', async (_e, method, args = []) => {
    if (!YTM_METHODS.has(method)) throw new Error('Bilinmeyen işlem: ' + method);
    await readyPromise;
    return ytm[method](...args);
  });
  ipcMain.handle('auth:login', () => login());
  ipcMain.handle('auth:cookie', (_e, raw) => loginWithCookie(raw));
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('img:color', (_e, url) => dominantColor(url));
  ipcMain.handle('player:load', (_e, track) => player.load(track));
  ipcMain.on('player:cmd', (_e, cmd, arg) => player.command(cmd, arg));
  ipcMain.on('player:debug', (_e, show) => player.setDebugVisible(Boolean(show)));
  ipcMain.on('app:thumbar', (_e, playing) => updateThumbar(Boolean(playing)));
  ipcMain.on('app:title', (_e, title) => mainWindow?.setTitle(String(title || 'Tını')));
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\/(music\.)?youtube\.com\//.test(url)) return shell.openExternal(url);
    return null;
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  ytmSession().setUserAgent(app.userAgentFallback);
  // Google bir oturum çerezini silerse/geçersiz kılarsa nedenini kaydet
  ytmSession().cookies.on('changed', (_e, c, cause, removed) => {
    if (removed && AUTH_COOKIES.has(c.name) && cause !== 'overwrite') diag('cerez silindi', `${c.domain}:${c.name}`, cause);
  });
  if (!isMac) Menu.setApplicationMenu(null);
  readyPromise = initYtm();
  player = new Player({ partition: PARTITION, preload: path.join(__dirname, 'player-preload.cjs'), send });
  registerIpc();
  createMainWindow();
  updateThumbar(false);

  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
    else createMainWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  player?.destroy();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
