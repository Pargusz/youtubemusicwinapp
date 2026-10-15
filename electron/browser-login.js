// Google girişini bilgisayardaki gerçek tarayıcıda (Chrome / Edge / Brave) yapar.
//
// Google, uygulama içine gömülü tarayıcıları ve eski Chromium sürümlerini ("Bu tarayıcı veya
// uygulama güvenli olmayabilir") reddediyor. Ayrıca DevTools/otomasyon bağlantısıyla başlatılan
// tarayıcılarda navigator.webdriver = true olduğu için onları da reddediyor. Bu yüzden:
//   1) Kullanıcının kendi güncel tarayıcısı, uygulamaya ait ayrı bir profille ve HİÇBİR kontrol
//      bayrağı olmadan normal bir pencere olarak açılır (kişisel profiline dokunulmaz).
//   2) Pencere YouTube Music'e ulaşınca (giriş bitti) tarayıcı nazikçe kapatılır; kullanıcı
//      pencereyi kendisi kapatırsa da aynı adıma geçilir.
//   3) Aynı profil görünmez (headless) bir tarayıcıyla açılıp çerezler DevTools protokolüyle,
//      yalnızca bu süreçle konuşan bir boru üzerinden okunur. Bu sırada Google sayfası açılmaz.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

function candidates() {
  if (isWin) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
      ['Chrome', path.join(pf, 'Google\\Chrome\\Application\\chrome.exe')],
      ['Chrome', path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe')],
      ['Chrome', path.join(local, 'Google\\Chrome\\Application\\chrome.exe')],
      ['Edge', path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe')],
      ['Edge', path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')],
      ['Brave', path.join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
      ['Brave', path.join(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ];
  }
  return [
    ['Chrome', '/usr/bin/google-chrome'],
    ['Chrome', '/usr/bin/google-chrome-stable'],
    ['Edge', '/usr/bin/microsoft-edge'],
    ['Brave', '/usr/bin/brave-browser'],
  ];
}

export function findBrowser() {
  for (const [name, exe] of candidates()) {
    try {
      if (exe && fs.existsSync(exe)) return { name, exe };
    } catch {}
  }
  return null;
}

const KEEP_DOMAIN = /(^|\.)(youtube\.com|google\.com)$/;
const hasAuth = (cookies) =>
  cookies.some((c) => /(^|\.)youtube\.com$/.test(c.domain) && (c.name === 'SAPISID' || c.name === '__Secure-3PAPISID'));

const COMMON_FLAGS = (profileDir) => [
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-background-mode',
  // Cihaza bağlı oturum çerezleri (DBSC) başka bir uygulamaya taşınamaz: Chrome bunları bilgisayarın
  // TPM anahtarına bağlıyor ve kopyası birkaç dakikada geçersizleşiyor. Bu profil için hepsini kapat
  // (Chrome 155'te Google hesapları için ayrı bir "DeviceBoundSessionsForGoogle" özelliği var).
  '--disable-features=' +
    [
      'DeviceBoundSessions',
      'DeviceBoundSessionsForGoogle',
      'EnableBoundSessionCredentials',
      'EnableBoundSessionCredentialsContinuity',
      'BoundSessionCredentials',
    ].join(','),
];

// Windows: tarayıcı penceresinin başlığını oku (otomasyon bağlantısı kurmadan giriş bitti mi anlamak için)
function windowTitle(pid) {
  return new Promise((resolve) => {
    if (!isWin) return resolve('');
    execFile('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve('');
      const cols = String(stdout).trim().match(/"([^"]*)"/g) || [];
      resolve(cols.length ? cols[cols.length - 1].slice(1, -1) : '');
    });
  });
}

function closeGracefully(child) {
  if (isWin) {
    // /f olmadan: pencereye kapat mesajı gider, tarayıcı çerezleri diske yazıp düzgün kapanır
    execFile('taskkill', ['/pid', String(child.pid)], { windowsHide: true }, () => {});
  } else {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {}
    }
  }, 10000);
}

// 1-2) Kullanıcının giriş yaptığı normal tarayıcı penceresi; pencere kapanınca biter
function interactiveLogin({ exe, profileDir, url, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(exe, [...COMMON_FLAGS(profileDir), '--new-window', '--window-size=560,820', url], {
      stdio: 'ignore',
      windowsHide: false,
    });
    let closing = false;
    const poll = setInterval(async () => {
      if (closing || child.exitCode !== null) return;
      const title = await windowTitle(child.pid);
      // Google girişi bitince music.youtube.com'a yönlendirir; sayfa başlığı "YouTube Music" olur
      if (/YouTube M(usic|üzik)/i.test(title)) {
        closing = true;
        setTimeout(() => closeGracefully(child), 1500);
      }
    }, 1500);
    const limit = setTimeout(() => !closing && ((closing = true), closeGracefully(child)), timeoutMs);
    const finish = () => {
      clearInterval(poll);
      clearTimeout(limit);
      resolve();
    };
    child.on('exit', finish);
    child.on('error', finish);
  });
}

// 3) Profilin çerezlerini görünmez tarayıcıyla oku
export function readCookies({ exe, profileDir }) {
  return new Promise((resolve) => {
    const child = spawn(exe, [...COMMON_FLAGS(profileDir), '--headless=new', '--remote-debugging-pipe', 'about:blank'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = child.stdio[3];
    const inp = child.stdio[4];
    let buf = '';
    let settled = false;
    const done = (cookies) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      // Tarayıcı tamamen kapanana kadar bekle: profil dosyaları kilitliyken silinemiyor
      const finish = () => resolve(cookies);
      if (child.exitCode !== null) return finish();
      child.once('exit', finish);
      try {
        out.write(JSON.stringify({ id: 2, method: 'Browser.close' }) + '\0');
      } catch {}
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill();
          } catch {}
        }
        setTimeout(finish, 1000);
      }, 5000);
    };
    inp.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(raw);
          if (msg.id === 1) done(msg.result?.cookies || []);
        } catch {}
      }
    });
    out.on('error', () => {});
    inp.on('error', () => {});
    out.write(JSON.stringify({ id: 1, method: 'Storage.getCookies' }) + '\0');
    const limit = setTimeout(() => done(null), 20000);
    child.on('exit', () => done(null));
    child.on('error', () => {
      settled = true;
      clearTimeout(limit);
      resolve(null);
    });
  });
}

// Giriş tamamlanınca youtube.com / google.com çerezlerini döndürür; giriş yapılmadıysa null.
export async function loginWithBrowser({ exe, profileDir, url, timeoutMs = 10 * 60 * 1000 }) {
  fs.mkdirSync(profileDir, { recursive: true });
  await interactiveLogin({ exe, profileDir, url, timeoutMs });
  // profil kilidinin bırakılması için kısa bekleme
  await new Promise((r) => setTimeout(r, 800));
  const cookies = await readCookies({ exe, profileDir });
  if (!cookies || !hasAuth(cookies)) return null;
  return cookies.filter((c) => KEEP_DOMAIN.test(c.domain.replace(/^\./, '')));
}

// CDP çerezini Electron session.cookies.set biçimine çevirir
export function toElectronCookie(c) {
  const host = c.domain.replace(/^\./, '');
  const sameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[c.sameSite] || 'unspecified';
  const cookie = {
    url: `https://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite,
  };
  // __Host- çerezleri domain özniteliği taşıyamaz; host'a özel çerezlerde de domain verilmez
  if (!c.name.startsWith('__Host-') && c.domain.startsWith('.')) cookie.domain = c.domain;
  if (!c.session && c.expires > 0) cookie.expirationDate = c.expires;
  return cookie;
}
