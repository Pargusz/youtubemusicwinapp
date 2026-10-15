// Ses çalma motoru: music.youtube.com'u gizli bir pencerede açar ve sayfadaki
// YouTube oynatıcısını (#movie_player) uzaktan kumanda eder.
import { BrowserWindow, ipcMain, session } from 'electron';

const WATCH_URL = (id) => `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`;

const PROBE = `(() => {
  const p = document.getElementById('movie_player');
  if (!p || typeof p.getPlayerState !== 'function') return null;
  const d = p.getVideoData ? p.getVideoData() : {};
  const err = document.querySelector('#movie_player .ytp-error');
  return {
    st: p.getPlayerState(),
    t: p.getCurrentTime() || 0,
    d: p.getDuration() || 0,
    vid: d && d.video_id,
    ad: p.classList.contains('ad-showing'),
    vol: p.getVolume ? p.getVolume() : null,
    muted: p.isMuted ? p.isMuted() : false,
    err: !!(err && err.offsetParent !== null),
  };
})()`;

export class Player {
  constructor({ partition, preload, send }) {
    this.partition = partition;
    this.preload = preload;
    this.send = send; // (channel, payload) => renderer'a gönder
    this.win = null;
    this.ready = false;
    this.expected = null; // çalması gereken videoId
    this.meta = null;
    this.volume = 80;
    this.muted = false;
    this.loadedAt = 0;
    this.mismatch = 0;
    this.endedFor = null;
    this.errorFor = null;
    this.metaFor = null;
    this.timer = null;
    this.debugVisible = false;

    // Gizli oynatıcı penceresi hiç görünmüyor; kapak görselleri, avatarlar ve yazı tipleri boşuna
    // indirilip çözülüyordu. Bunları engellemek bellek, ağ ve CPU kullanımını belirgin düşürür.
    session.fromPartition(partition).webRequest.onBeforeRequest((details, cb) => {
      const wc = this.win && !this.win.isDestroyed() ? this.win.webContents : null;
      if (!wc || details.webContentsId !== wc.id || this.debugVisible) return cb({});
      if (details.resourceType === 'image' || details.resourceType === 'font') return cb({ cancel: true });
      cb({});
    });

    ipcMain.on('player:ended', (e) => {
      if (e.sender !== this.win?.webContents) return;
      this.#emitEnded('ended');
    });
    ipcMain.on('player:media', (e, action) => {
      if (e.sender !== this.win?.webContents) return;
      this.send('player:media', action);
    });
  }

  #createWindow() {
    this.win = new BrowserWindow({
      show: this.debugVisible,
      width: 1100,
      height: 760,
      title: 'Tını — oynatıcı',
      skipTaskbar: !this.debugVisible,
      webPreferences: {
        partition: this.partition,
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    this.win.setMenuBarVisibility(false);
    this.win.webContents.setAudioMuted(this.#silent || Boolean(process.env.TINI_MUTE));
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.on('close', (e) => {
      // Hata ayıklama için gösterildiyse kapatmak yerine gizle
      if (!this.destroying) {
        e.preventDefault();
        this.setDebugVisible(false);
      }
    });
    this.win.webContents.on('did-navigate', (_e, url) => {
      if (/consent\.(youtube|google)\./.test(url)) this.#handleConsent();
    });
    this.win.webContents.on('render-process-gone', () => {
      this.ready = false;
    });
    this.ready = false;
  }

  async #handleConsent() {
    // AB ülkelerinde çıkan çerez onayı: en gizli seçenek olan "Tümünü reddet"
    try {
      await this.win.webContents.executeJavaScript(`(() => {
        const btns = [...document.querySelectorAll('form button, button')];
        const b = btns.find(b => /reddet|reject|ablehnen|rechazar|refuser|rifiuta|weiger/i.test(b.textContent)) || btns[0];
        b && b.click();
      })()`);
    } catch {}
  }

  #exec(code) {
    if (!this.win || this.win.isDestroyed()) return Promise.resolve(null);
    // Sayfa yüklenirken/donmuşken executeJavaScript hiç dönmeyebilir; yoklama döngüsü
    // (ve onunla ses/durum takibi) takılı kalmasın diye zaman aşımı koy
    const run = this.win.webContents.executeJavaScript(code, true).catch(() => null);
    return Promise.race([run, new Promise((r) => setTimeout(() => r(null), 3000))]);
  }

  #emitEnded(reason) {
    if (!this.expected || this.endedFor === this.expected) return;
    this.endedFor = this.expected;
    this.send('player:ended', { videoId: this.expected, reason });
  }

  // Çalarken/yüklenirken 4 Hz, duraklatılmışken 1 Hz yokla (boşta CPU harcamasın)
  #startPolling() {
    if (this.timer) return;
    const gen = (this.pollGen = (this.pollGen || 0) + 1);
    const tick = async () => {
      await this.#poll();
      if (this.pollGen !== gen || !this.timer) return;
      const busy = this.expected && this.lastState !== 2 && this.lastState !== 0;
      this.timer = setTimeout(tick, busy ? 250 : 1000);
    };
    this.timer = setTimeout(tick, 0);
  }

  #kick() {
    // komut sonrası durumu hemen yansıtmak için yoklamayı öne çek
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.#startPolling();
  }

  async #poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const s = await this.#exec(PROBE);
      if (!s) return;
      this.lastState = s.st;

      // YouTube Music şarkı/reklam geçişlerinde kendi kayıtlı sesini geri yükleyebiliyor; ayarı koru
      if (s.vol != null) {
        const drift = this.#silent ? !s.muted : s.muted || s.vol !== playerVolume(this.volume);
        if (drift) this.#applyVolume();
      }
      this.ready = true;
      const ours = s.vid === this.expected;

      // YouTube Music şarkı bitince kendi önerisine geçebiliyor. Bunu bitiş say; uygulama sıradaki
      // şarkıyı yükleyecek. Hemen duraklatmak, uygulamanın az sonra yüklediği şarkıyı da
      // duraklatıyordu (sıradaki şarkı "duraklatılmış" başlıyordu). Yalnızca 2 sn içinde yeni
      // bir şarkı yüklenmezse yabancı şarkıyı durdur.
      if (!s.ad && this.expected && s.vid && !ours && s.st === 1 && Date.now() - this.loadedAt > 1500) {
        if (++this.mismatch >= 2) {
          if (!this.foreignSince) {
            this.foreignSince = Date.now();
            this.#emitEnded('external');
          } else if (Date.now() - this.foreignSince > 2000 && this.loadedAt < this.foreignSince) {
            this.#exec(`document.getElementById('movie_player')?.pauseVideo()`);
          }
        }
      } else {
        this.mismatch = 0;
        this.foreignSince = 0;
      }

      // Başa sarma / yeniden yükleme sonrası oynatıcı kısa bir süre hâlâ "bitti" durumunu
      // bildirebiliyor; bu eski durumu yeni bir bitiş sanıp kuyruğu ilerletme
      const settled = Date.now() - Math.max(this.loadedAt, this.seekAt || 0) > 1500;
      if (ours && s.st === 0 && settled) this.#emitEnded('ended');

      const stuck = Date.now() - this.loadedAt > 15000 && (s.st === -1 || s.st === 5) && ours;
      if (this.expected && (s.err || stuck) && this.errorFor !== this.expected) {
        this.errorFor = this.expected;
        this.send('player:error', { videoId: this.expected });
      }

      if (ours && s.st === 1 && this.metaFor !== this.expected && this.meta) {
        this.metaFor = this.expected;
        this.#applyMeta();
      }

      this.send('player:state', {
        videoId: this.expected,
        state: s.ad ? 'ad' : ours ? stateName(s.st) : 'loading',
        time: ours ? s.t : 0,
        duration: ours ? s.d : 0,
        isAd: s.ad,
      });
    } finally {
      this.polling = false;
    }
  }

  #applyMeta() {
    const m = this.meta;
    const art = m.thumbnail ? [{ src: m.thumbnail, sizes: '544x544', type: 'image/jpeg' }] : [];
    this.#exec(
      `window.__tuneSetMeta && window.__tuneSetMeta(${JSON.stringify({
        title: m.title || '',
        artist: (m.artists || []).map((a) => a.name).join(', '),
        album: m.album?.name || '',
        artwork: art,
      })})`,
    );
  }

  async load(track) {
    const videoId = track.videoId;
    this.expected = videoId;
    this.meta = track;
    this.endedFor = null;
    this.errorFor = null;
    this.metaFor = null;
    this.mismatch = 0;
    this.loadedAt = Date.now();
    this.foreignSince = 0;
    this.lastState = null;
    if (!this.win || this.win.isDestroyed()) this.#createWindow();
    this.#startPolling();
    this.#kick();

    let ok = false;
    if (this.ready) {
      ok = await this.#exec(`(() => {
        const p = document.getElementById('movie_player');
        if (!p || !p.loadVideoById) return false;
        // Başlangıç saniyesi açıkça 0 verilmeli: verilmezse YouTube aynı videoyu kaldığı yerden
        // (bitmiş bir şarkıda en sondan) açıyor ve tekrar modu "bitti" durumunda takılıyordu.
        // Bitmiş videoda seekTo(0) + playVideo ise 0. saniyede donup kalıyor.
        p.loadVideoById(${JSON.stringify(videoId)}, 0);
        return true;
      })()`);
    }
    if (!ok) {
      this.ready = false;
      try {
        await this.win.loadURL(WATCH_URL(videoId));
      } catch {
        // yönlendirmeler (ör. çerez onayı) loadURL'i iptal edebilir; yoklama devam eder
      }
      // "Takıldı" süresi sayfa yüklendikten sonra başlasın: girişten sonraki ilk şarkıda tüm
      // YouTube Music sayfasının yüklenmesi 15 sn'yi aşabiliyor ve şarkı yanlışlıkla atlanıyordu
      if (this.expected === videoId) this.loadedAt = Date.now();
    }
    this.#applyVolume();
    this.#exec(`(() => { const p = document.getElementById('movie_player'); p && p.setPlaybackQualityRange && p.setPlaybackQualityRange('tiny', 'tiny'); })()`);
    return true;
  }

  get #silent() {
    return this.muted || this.volume <= 0;
  }

  #applyVolume() {
    const silent = this.#silent;
    // Sessizlik Chromium düzeyinde de garanti: sayfa ne yaparsa yapsın pencereden ses çıkmaz
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.setAudioMuted(silent || Boolean(process.env.TINI_MUTE));
    }
    // Sıra önemli: YouTube, ses 0'dayken unMute() çağrılınca sesi kendiliğinden 5'e çıkarıyor.
    // Bu yüzden sessizlik yalnızca mute() ile yapılır, ses düzeyine dokunulmaz.
    this.#exec(`(() => {
      const p = document.getElementById('movie_player');
      if (!p || !p.setVolume) return;
      if (${silent}) { if (!p.isMuted()) p.mute(); return; }
      if (p.isMuted()) p.unMute();
      if (p.getVolume() !== ${playerVolume(this.volume)}) p.setVolume(${playerVolume(this.volume)});
    })()`);
  }

  command(cmd, arg) {
    switch (cmd) {
      case 'play':
        // oturum yenilendiyse pencere yok: şarkıyı baştan yükle
        if (!this.win || this.win.isDestroyed()) return this.meta ? this.load(this.meta) : null;
        this.lastState = null;
        this.#kick();
        return this.#exec(`document.getElementById('movie_player')?.playVideo()`).then(() => this.#kick());
      case 'pause':
        return this.#exec(`document.getElementById('movie_player')?.pauseVideo()`).then(() => this.#kick());
      case 'seek':
        this.endedFor = null;
        this.seekAt = Date.now();
        return this.#exec(`document.getElementById('movie_player')?.seekTo(${Number(arg) || 0}, true)`).then(() => this.#kick());
      case 'volume':
        this.volume = Math.max(0, Math.min(100, Number(arg)));
        return this.#applyVolume();
      case 'mute':
        this.muted = Boolean(arg);
        return this.#applyVolume();
      case 'stop':
        this.expected = null;
        return this.#exec(`document.getElementById('movie_player')?.pauseVideo()`);
      default:
        return null;
    }
  }

  setDebugVisible(show) {
    this.debugVisible = show;
    if (!this.win || this.win.isDestroyed()) return;
    if (show) {
      this.win.setSkipTaskbar(false);
      this.win.show();
    } else {
      this.win.hide();
      this.win.setSkipTaskbar(true);
    }
    this.send('player:debug', show);
  }

  // Giriş/çıkış sonrası oturumu yenile
  async resetSession() {
    const current = this.meta;
    this.destroy();
    if (current) this.send('player:state', { videoId: current.videoId, state: 'paused', time: 0, duration: 0 });
  }

  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
    this.pollGen = (this.pollGen || 0) + 1;
    this.ready = false;
    if (this.win && !this.win.isDestroyed()) {
      this.destroying = true;
      this.win.destroy();
      this.destroying = false;
    }
    this.win = null;
  }
}

// Kaydırıcı (0-100) → YouTube oynatıcı sesi (yalnızca tam sayı kabul ediyor). Kulak sesi
// logaritmik algıladığı için doğrusal eşlemede alt uç çok yüksek, üst yarı farksız geliyordu.
function playerVolume(v) {
  if (v <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round(100 * Math.pow(v / 100, 1.6))));
}

function stateName(st) {
  switch (st) {
    case 1:
      return 'playing';
    case 2:
      return 'paused';
    case 3:
      return 'buffering';
    case 0:
      return 'ended';
    default:
      return 'loading';
  }
}
