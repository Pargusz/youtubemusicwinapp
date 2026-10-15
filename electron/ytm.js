// YouTube Music veri katmanı: youtubei.js çıktısını arayüzün kullandığı sade nesnelere çevirir.
import { Innertube, YTNodes, Parser, Log } from 'youtubei.js';

// YouTube yanıt biçimini değiştirdiğinde youtubei.js her düğüm için uyarı üretir. Paketlenmiş
// sürümde bu uyarı kodu package.json'daki eksik "bugs" alanı yüzünden hata fırlatıp tüm isteği
// (ör. aramayı) çökertiyordu; ayrıca her uyarıda büyük JSON dökümü yapması yavaştı. Sessize al.
Parser.setParserErrorHandler(() => {});
Log.setLevel(Log.Level.ERROR);

let yt = null;
let loggedIn = false;
let initOpts = { lang: 'tr', location: 'TR' };

export async function init({ cookie, lang, location } = {}) {
  if (lang) initOpts.lang = lang;
  if (location) initOpts.location = location;
  accountCache = null;
  const create = (withCookie) =>
    Innertube.create({
      retrieve_player: false,
      lang: initOpts.lang,
      location: initOpts.location,
      ...(withCookie ? { cookie } : {}),
    });
  yt = await create(Boolean(cookie));
  loggedIn = false;
  if (!cookie || !yt.session.logged_in) return { loggedIn };
  // youtubei.js yalnızca SAPISID çerezinin varlığına bakıyor. Google oturumu geçersiz kıldıysa
  // arayüz "giriş yapıldı" gösterip her hesap işleminde hata veriyordu; gerçek bir istekle doğrula.
  loggedIn = true;
  let me;
  try {
    me = await fetchAccount();
  } catch {
    return { loggedIn }; // ağ hatası: doğrulanamadı, oturumu koru
  }
  if (me) {
    accountCache = me;
    return { loggedIn };
  }
  loggedIn = false;
  yt = await create(false);
  return { loggedIn, invalidSession: true };
}

// Hesap bilgisi ham yanıttan okunur: youtubei.js'in ayrıştırıcısı activeAccountHeaderRenderer'ı
// artık tanımadığı için ayrıştırılmış yanıtta hesap hiç görünmüyordu (geçerli oturum "geçersiz"
// sanılıyor, hesap adı hep "Hesabım" kalıyordu).
async function fetchAccount() {
  const res = await client().actions.execute('/account/account_menu', { client: 'YTMUSIC', parse: false });
  const data = res?.data || {};
  const params = (data.responseContext?.serviceTrackingParams || []).flatMap((p) => p.params || []);
  const flag = params.find((p) => p.key === 'logged_in')?.value;
  const h = findDeep(data, (o) => o.activeAccountHeaderRenderer)?.activeAccountHeaderRenderer;
  if (!h && flag !== '1') return null;
  const text = (t) => t?.simpleText || (t?.runs || []).map((r) => r.text).join('') || '';
  return {
    loggedIn: true,
    name: text(h?.accountName) || 'Hesabım',
    handle: text(h?.channelHandle),
    photo: bestThumb(h?.accountPhoto?.thumbnails, 96),
  };
}

const client = () => {
  if (!yt) throw new Error('YouTube Music bağlantısı henüz hazır değil');
  return yt;
};

const requireLogin = () => {
  if (!loggedIn) throw new Error('Bu işlem için giriş yapmalısın');
};

// ---------- yardımcılar ----------

const PAGE = {
  ARTIST: 'MUSIC_PAGE_TYPE_ARTIST',
  USER: 'MUSIC_PAGE_TYPE_USER_CHANNEL',
  LIB_ARTIST: 'MUSIC_PAGE_TYPE_LIBRARY_ARTIST',
  ALBUM: 'MUSIC_PAGE_TYPE_ALBUM',
  PLAYLIST: 'MUSIC_PAGE_TYPE_PLAYLIST',
};

const pageTypeOf = (ep) =>
  ep?.payload?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;

const DURATION_RE = /^\d{1,2}(:\d{2}){1,2}$/;
const NOT_ARTIST_RE = /dinlen|görüntüleme|izlenme|views|plays|abone|subscriber/i;

export function parseDuration(text) {
  if (!text || !DURATION_RE.test(text.trim())) return 0;
  return text.trim().split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function upscale(url, size = 544) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    if (/=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+/, `=w${size}-h${size}`);
    if (/=s\d+/.test(url)) return url.replace(/=s\d+/, `=s${size}`);
  }
  return url;
}

function bestThumb(list, size) {
  const arr = Array.isArray(list) ? list : list?.contents;
  if (!arr?.length) return null;
  const best = [...arr].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return upscale(best?.url, size);
}

const isArtistPage = (pt) => pt === PAGE.ARTIST || pt === PAGE.USER || pt === PAGE.LIB_ARTIST;

function artistsFromRuns(runs = []) {
  return runs
    .filter((r) => isArtistPage(pageTypeOf(r.endpoint)))
    .map((r) => ({ name: r.text, id: r.endpoint.payload.browseId }));
}

function albumFromRuns(runs = []) {
  const r = runs.find((r) => pageTypeOf(r.endpoint) === PAGE.ALBUM);
  return r ? { name: r.text, id: r.endpoint.payload.browseId } : null;
}

// "Şarkı • Tarkan • 3:15" gibi metinlerdeki tür etiketleri
const TYPE_LABELS = new Set([
  'Şarkı', 'Video', 'Albüm', 'Single', 'EP', 'Oynatma listesi', 'Sanatçı', 'Profil', 'Bölüm', 'Podcast',
  'Song', 'Album', 'Playlist', 'Artist', 'Profile', 'Episode',
]);

function cleanSubtitle(text = '') {
  const parts = text.split(' • ').filter(Boolean);
  if (parts.length > 1 && TYPE_LABELS.has(parts[0])) parts.shift();
  return parts.join(' • ');
}

function hasExplicit(badges) {
  return Boolean(badges?.some?.((b) => b?.icon_type === 'MUSIC_EXPLICIT_BADGE'));
}

function kindFromIds({ itemType, videoId, browseId, pageType }) {
  if (itemType === 'song' || itemType === 'video') return itemType;
  if (itemType === 'album') return 'album';
  if (itemType === 'playlist') return 'playlist';
  if (itemType === 'artist' || itemType === 'library_artist') return 'artist';
  if (pageType === PAGE.ALBUM || browseId?.startsWith('MPRE')) return 'album';
  if (pageType === PAGE.PLAYLIST || browseId?.startsWith('VL') || browseId?.startsWith('RD')) return 'playlist';
  if (isArtistPage(pageType) || browseId?.startsWith('UC')) return 'artist';
  if (videoId) return 'song';
  return null;
}

// ---------- düğüm dönüştürücüler ----------

function fromResponsive(it) {
  const cols = (it.flex_columns || []).map((c) => c.title);
  const title = cols[0]?.text || it.title || it.name;
  if (!title) return null;
  const restRuns = cols.slice(1).flatMap((c) => c?.runs || []);
  const restText = cols.slice(1).map((c) => c?.text).filter(Boolean).join(' • ');

  const videoId =
    it.overlay?.content?.endpoint?.payload?.videoId ||
    cols[0]?.runs?.[0]?.endpoint?.payload?.videoId ||
    it.endpoint?.payload?.videoId ||
    (['song', 'video'].includes(it.item_type) ? it.id : undefined);
  const browseId = it.endpoint?.payload?.browseId;
  const pageType = pageTypeOf(it.endpoint);
  const kind = kindFromIds({ itemType: it.item_type, videoId, browseId, pageType });
  if (!kind) return null;

  const thumbnail = bestThumb(it.thumbnail?.contents);

  if (kind === 'song' || kind === 'video') {
    if (!videoId) return null;
    let artists = artistsFromRuns(restRuns);
    if (!artists.length && it.artists?.length) artists = it.artists.map((a) => ({ name: a.name, id: a.channel_id }));
    if (!artists.length && it.authors?.length) artists = it.authors.map((a) => ({ name: a.name, id: a.channel_id }));
    if (!artists.length && restText) {
      // bağlantısız sanatçı adı (ör. albüm parçaları)
      const first = cleanSubtitle(restText).split(' • ')[0];
      if (first && !DURATION_RE.test(first) && !NOT_ARTIST_RE.test(first)) artists = [{ name: first, id: null }];
    }
    const durText =
      it.fixed_columns?.[0]?.title?.text || restRuns.map((r) => r.text?.trim()).find((t) => DURATION_RE.test(t || ''));
    return {
      kind,
      videoId,
      title,
      artists,
      album: albumFromRuns(restRuns) || (it.album?.id ? { name: it.album.name, id: it.album.id } : null),
      duration: it.duration?.seconds || parseDuration(durText),
      thumbnail,
      explicit: hasExplicit(it.badges),
      setVideoId: it.playlist_set_video_id || undefined,
    };
  }

  return {
    kind,
    id: browseId,
    title,
    subtitle: cleanSubtitle(restText),
    thumbnail,
    playlistId: it.overlay?.content?.endpoint?.payload?.playlistId,
    artists: artistsFromRuns(restRuns),
  };
}

function fromTwoRow(it) {
  const title = it.title?.text;
  if (!title) return null;
  const p = it.endpoint?.payload || {};
  const videoId = p.videoId;
  const browseId = p.browseId;
  const pageType = pageTypeOf(it.endpoint);
  const kind = kindFromIds({ itemType: it.item_type, videoId, browseId, pageType });
  if (!kind) return null;
  const runs = it.subtitle?.runs || [];
  const thumbnail = bestThumb(it.thumbnail);
  if (kind === 'song' || kind === 'video') {
    return {
      kind,
      videoId,
      title,
      artists: artistsFromRuns(runs).length
        ? artistsFromRuns(runs)
        : [{ name: cleanSubtitle(it.subtitle?.text || '').split(' • ')[0], id: null }],
      album: albumFromRuns(runs),
      duration: 0,
      thumbnail,
      explicit: hasExplicit(it.badges),
    };
  }
  return {
    kind,
    id: browseId,
    title,
    subtitle: cleanSubtitle(it.subtitle?.text || ''),
    thumbnail,
    playlistId: it.thumbnail_overlay?.content?.endpoint?.payload?.playlistId,
    artists: artistsFromRuns(runs),
  };
}

function fromPanelVideo(it) {
  if (!it.video_id) return null;
  return {
    kind: 'song',
    videoId: it.video_id,
    title: it.title?.text || it.title,
    artists: (it.artists || []).map((a) => ({ name: a.name, id: a.channel_id || null })),
    album: it.album?.id ? { name: it.album.name, id: it.album.id } : null,
    duration: it.duration?.seconds || 0,
    thumbnail: bestThumb(it.thumbnail),
    explicit: false,
  };
}

function fromCardShelf(card) {
  const p = card.on_tap?.payload || {};
  const pageType = pageTypeOf(card.on_tap);
  const videoId = p.videoId;
  const browseId = p.browseId;
  const kind = kindFromIds({ videoId, browseId, pageType });
  if (!kind) return null;
  const runs = card.subtitle?.runs || [];
  const base = {
    kind,
    title: card.title?.text,
    subtitle: cleanSubtitle(card.subtitle?.text || ''),
    typeLabel: (card.subtitle?.text || '').split(' • ')[0],
    thumbnail: bestThumb(card.thumbnail?.contents || card.thumbnail),
  };
  if (kind === 'song' || kind === 'video') {
    return { ...base, videoId, artists: artistsFromRuns(runs), album: albumFromRuns(runs), duration: 0 };
  }
  return { ...base, id: browseId };
}

const MOOD_COLORS = [
  '#e13300', '#1e3264', '#8400e7', '#e8115b', '#148a08', '#bc5900', '#477d95', '#af2896',
  '#503750', '#0d73ec', '#8d67ab', '#ba5d07', '#27856a', '#e91429', '#509bf5', '#a56752',
];

function hashColor(text = '') {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return MOOD_COLORS[h % MOOD_COLORS.length];
}

function fromNavButton(b) {
  const p = b.endpoint?.payload || {};
  if (!p.browseId) return null;
  return { kind: 'mood', id: p.browseId, params: p.params, title: b.button_text, color: hashColor(b.button_text) };
}

export function normalize(node) {
  if (!node) return null;
  try {
    switch (node.type) {
      case 'MusicResponsiveListItem':
        return fromResponsive(node);
      case 'MusicTwoRowItem':
        return fromTwoRow(node);
      case 'PlaylistPanelVideo':
        return fromPanelVideo(node);
      case 'PlaylistPanelVideoWrapper':
        return fromPanelVideo(node.primary);
      case 'MusicNavigationButton':
        return fromNavButton(node);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const normalizeList = (list) => (list || []).map(normalize).filter(Boolean);

function sectionLayout(items) {
  if (items.length && items.every((i) => i.kind === 'mood')) return 'moods';
  const tracks = items.filter((i) => i.kind === 'song' || i.kind === 'video').length;
  return tracks > items.length / 2 ? 'tracks' : 'cards';
}

function normalizeSection(sec) {
  if (!sec) return null;
  const title =
    sec.header?.title?.text || sec.title?.text || sec.header?.title || (typeof sec.title === 'string' ? sec.title : '');
  const items = normalizeList(sec.contents || sec.items);
  if (!items.length) return null;
  const more = sec.header?.more_content?.endpoint?.payload || sec.bottom_endpoint?.payload || sec.endpoint?.payload;
  return {
    title,
    strapline: sec.header?.strapline?.text || '',
    items,
    layout: sectionLayout(items),
    more: more?.browseId ? { id: more.browseId, params: more.params } : null,
  };
}

// Yanıttaki tüm bölümleri (carousel, shelf, grid) toplar.
function collectSections(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (!n) continue;
    if (['MusicCarouselShelf', 'MusicShelf', 'Grid', 'MusicPlaylistShelf'].includes(n.type)) {
      const s = normalizeSection(n);
      if (s) out.push(s);
    } else if (n.type === 'ItemSection' || n.type === 'SectionList') {
      out.push(...collectSections(n.contents));
    }
  }
  return out;
}

// ---------- ana sayfa ----------

export async function home(filter) {
  let feed = await client().music.getHomeFeed();
  const chips = feed.filters || [];
  if (filter) feed = await feed.applyFilter(filter);
  const sections = collectSections(feed.sections);
  // ilk sayfa kısa geliyor; birkaç devam sayfası daha yükle
  for (let i = 0; i < 3 && feed.has_continuation; i++) {
    try {
      feed = await feed.getContinuation();
      sections.push(...collectSections(feed.sections));
    } catch {
      break;
    }
  }
  return { chips, active: filter || null, sections };
}

// ---------- arama ----------

const FILTERS = { songs: 'song', videos: 'video', albums: 'album', artists: 'artist', playlists: 'playlist' };

export async function search(query, filter) {
  const q = String(query || '').trim();
  if (!q) return { query: q, top: null, sections: [] };
  const m = client().music;

  if (filter && FILTERS[filter]) {
    const res = await m.search(q, { type: FILTERS[filter] });
    let items = [];
    for (const c of res.contents || []) items.push(...normalizeList(c.contents));
    if (items.length < 40 && res.has_continuation) {
      try {
        const more = await res.getContinuation();
        items.push(...normalizeList(more.contents?.contents));
      } catch {}
    }
    return { query: q, filter, items };
  }

  const res = await m.search(q);
  let top = null;
  const flat = [];
  for (const c of res.contents || []) {
    if (c.type === 'MusicCardShelf') {
      top = fromCardShelf(c);
      // kart içindeki şarkılarda sanatçı bağlantısı olmuyor; üst sonuç sanatçıysa onu kullan
      const fallback = top?.kind === 'artist' ? [{ name: top.title, id: top.id }] : top?.artists || [];
      flat.push(
        ...normalizeList(c.contents).map((i) =>
          (i.kind === 'song' || i.kind === 'video') && !i.artists?.length ? { ...i, artists: fallback } : i,
        ),
      );
    } else if (c.type === 'ItemSection' || c.type === 'MusicShelf') {
      flat.push(...normalizeList(c.contents));
    }
  }
  const by = (k) => flat.filter((i) => i.kind === k);
  const seen = new Set();
  const uniq = (arr) =>
    arr.filter((i) => {
      const key = i.videoId || i.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    query: q,
    top,
    songs: uniq(by('song')).slice(0, 8),
    videos: uniq(by('video')),
    artists: uniq(by('artist')),
    albums: uniq(by('album')),
    playlists: uniq(by('playlist')),
    corrected: res.did_you_mean?.corrected_query?.text || res.showing_results_for?.corrected_query?.text || null,
  };
}

export async function suggestions(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const sections = await client().music.getSearchSuggestions(q);
  const out = [];
  for (const sec of sections || []) {
    for (const c of sec.contents || []) {
      if (c.type === 'SearchSuggestion') out.push({ type: 'query', text: c.suggestion?.text });
      else {
        const n = normalize(c);
        if (n) out.push({ type: 'item', item: n });
      }
    }
  }
  return out.filter((s) => s.type === 'item' || s.text);
}

// ---------- oynatma listesi / albüm ----------

function readHeader(h) {
  if (!h) return {};
  if (h.type === 'MusicEditablePlaylistDetailHeader') return { ...readHeader(h.header), editable: true };
  const strap = h.strapline_text_one;
  const authorRun = strap?.runs?.find((r) => r.endpoint) || null;
  return {
    title: h.title?.text,
    subtitle: h.subtitle?.text,
    secondSubtitle: h.second_subtitle?.text,
    description: h.description?.description?.text || h.description?.text || '',
    thumbnail: bestThumb(h.thumbnail?.contents || h.thumbnail),
    author: strap?.text
      ? { name: strap.text, id: authorRun?.endpoint?.payload?.browseId || null }
      : h.author
        ? { name: h.author.name, id: h.author.channel_id }
        : null,
    authorThumb: bestThumb(h.strapline_thumbnail?.contents, 96),
  };
}

export async function playlist(id, { limit = 1000 } = {}) {
  let pid = String(id);
  if (pid.startsWith('VL')) pid = pid.slice(2);
  let pl = await client().music.getPlaylist(pid);
  const header = readHeader(pl.header);
  const tracks = normalizeList(pl.items).filter((t) => t.videoId);
  while (pl.has_continuation && tracks.length < limit) {
    try {
      pl = await pl.getContinuation();
      tracks.push(...normalizeList(pl.items).filter((t) => t.videoId));
    } catch {
      break;
    }
  }
  return {
    kind: 'playlist',
    id: pid,
    ...header,
    title: header.title || (pid === 'LM' ? 'Beğenilen Şarkılar' : 'Oynatma listesi'),
    editable: Boolean(header.editable),
    tracks,
  };
}

export async function album(id) {
  const al = await client().music.getAlbum(id);
  const header = readHeader(al.header);
  const albumRef = { name: header.title, id };
  const artist = header.author;
  const tracks = normalizeList(al.contents)
    .filter((t) => t.videoId)
    .map((t, i) => ({
      ...t,
      kind: 'song',
      thumbnail: t.thumbnail || header.thumbnail,
      album: t.album || albumRef,
      artists: t.artists?.length && t.artists[0].name ? t.artists : artist ? [artist] : [],
      index: i + 1,
    }));
  const playlistId = al.page?.microformat?.url_canonical?.match(/list=([\w-]+)/)?.[1] || null;
  return {
    kind: 'album',
    id,
    ...header,
    playlistId,
    tracks,
    sections: collectSections(al.sections),
  };
}

// ---------- sanatçı ----------

export async function artist(id) {
  const [ar, raw] = await Promise.all([
    client().music.getArtist(id),
    client()
      .actions.execute('/browse', { browseId: id, client: 'YTMUSIC', parse: false })
      .catch(() => null),
  ]);
  const h = ar.header || {};
  const rawHeader = raw?.data?.header ? Object.values(raw.data.header)[0] : null;
  const monthly = rawHeader?.monthlyListenerCount?.runs?.map((r) => r.text).join('') || '';
  const sections = [];
  let topSongs = null;
  for (const s of ar.sections || []) {
    const n = normalizeSection(s);
    if (!n) continue;
    if (s.type === 'MusicShelf' && !topSongs) topSongs = n;
    else sections.push(n);
  }
  return {
    kind: 'artist',
    id,
    name: h.title?.text || '',
    description: h.description?.text || '',
    thumbnail: bestThumb(h.thumbnail?.contents || h.thumbnail, 1200),
    avatar: bestThumb(h.foreground_thumbnail?.contents, 400),
    listeners: monthly || h.subscription_button?.subscriber_count?.text || '',
    topSongs,
    sections,
  };
}

// ---------- serbest gezinti (ruh halleri, "tümünü gör" sayfaları) ----------

export async function browse(browseId, params) {
  const res = await client().actions.execute('/browse', {
    browseId,
    ...(params ? { params } : {}),
    client: 'YTMUSIC',
    parse: true,
  });
  const header = res.header;
  const title = header?.title?.text || header?.header?.title?.text || '';
  const tab = res.contents?.tabs?.[0] || res.contents?.item?.()?.tabs?.[0];
  let nodes = tab?.content?.contents || res.contents?.contents || [];
  if (!Array.isArray(nodes) && nodes?.contents) nodes = nodes.contents;
  const sections = collectSections(Array.isArray(nodes) ? nodes : []);
  return { id: browseId, title, sections };
}

export async function moods() {
  const data = await browse('FEmusic_moods_and_genres');
  return data.sections;
}

// ---------- sıradakiler / şarkı sözleri ----------

export async function upNext(videoId, playlistId) {
  const m = client().music;
  let panel;
  if (playlistId) {
    const res = await client().actions.execute('/next', {
      videoId,
      playlistId,
      client: 'YTMUSIC',
      parse: true,
    });
    const tabs = res.contents_memo?.getType(YTNodes.PlaylistPanel);
    panel = tabs?.[0];
  } else {
    panel = await m.getUpNext(videoId, true);
  }
  return normalizeList(panel?.contents).filter((t) => t.videoId);
}

async function plainLyrics(videoId) {
  try {
    const shelf = await client().music.getLyrics(videoId);
    if (!shelf) return null;
    return { text: shelf.description?.text || '', source: shelf.footer?.text || '' };
  } catch {
    return null;
  }
}

function findDeep(obj, pred, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 40) return null;
  if (pred(obj)) return obj;
  for (const v of Object.values(obj)) {
    const r = findDeep(v, pred, depth + 1);
    if (r) return r;
  }
  return null;
}

// Zaman damgalı sözler: YouTube Music bunları yalnızca Android uygulamasına veriyor
const ANDROID_MUSIC = '8.47.54';

async function ytmTimedLyrics(videoId) {
  const next = await client().actions.execute('/next', { videoId, client: 'YTMUSIC', parse: false });
  const browseId = findDeep(next.data, (o) => typeof o.browseId === 'string' && o.browseId.startsWith('MPLY'))?.browseId;
  if (!browseId) return null;
  const res = await fetch('https://music.youtube.com/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `com.google.android.apps.youtube.music/${ANDROID_MUSIC} (Linux; U; Android 14) gzip`,
    },
    body: JSON.stringify({
      context: {
        client: { clientName: 'ANDROID_MUSIC', clientVersion: ANDROID_MUSIC, androidSdkVersion: 34, hl: initOpts.lang, gl: initOpts.location },
      },
      browseId,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const timed = findDeep(data, (o) => Array.isArray(o.timedLyricsData))?.timedLyricsData;
  if (!timed?.length) return null;
  const lines = timed
    .map((l) => ({ t: Number(l.cueRange?.startTimeMilliseconds || 0) / 1000, text: String(l.lyricLine ?? '').trim() }))
    .sort((a, b) => a.t - b.t);
  return lines.some((l) => l.text && l.text !== '♪') ? lines : null;
}

// Yedek kaynak: LRCLIB (ücretsiz, açık LRC veritabanı)
const LRCLIB_HEADERS = { 'User-Agent': 'Tini Music (masaüstü YouTube Music istemcisi)' };

async function lrclibFetch(pathAndQuery) {
  const res = await fetch('https://lrclib.net/api/' + pathAndQuery, { signal: AbortSignal.timeout(6000), headers: LRCLIB_HEADERS });
  return res.ok ? res.json() : null;
}

async function lrclibLyrics(meta) {
  if (!meta?.title) return null;
  // Video sürümlerinin başlığında "(Official Video)" gibi ekler olabiliyor
  const title = meta.title.replace(/\s*[([][^)\]]*(official|video|audio|lyric|klip|remaster)[^)\]]*[)\]]/gi, '').trim();
  const q = new URLSearchParams({ track_name: title, artist_name: meta.artist || '' });
  if (meta.album) q.set('album_name', meta.album);
  if (meta.duration) q.set('duration', String(Math.round(meta.duration)));
  let synced = (await lrclibFetch('get?' + q).catch(() => null))?.syncedLyrics;
  if (!synced) {
    // tam eşleşme yoksa ara; senkron sözü olanlardan süresi en yakın olanı seç
    const found = await lrclibFetch('search?' + new URLSearchParams({ track_name: title, artist_name: meta.artist || '' })).catch(() => null);
    const best = (Array.isArray(found) ? found : [])
      .filter((r) => r.syncedLyrics && (!meta.duration || Math.abs(r.duration - meta.duration) < 20))
      .sort((a, b) => Math.abs(a.duration - (meta.duration || a.duration)) - Math.abs(b.duration - (meta.duration || b.duration)))[0];
    synced = best?.syncedLyrics;
  }
  if (!synced) return null;
  const lines = [];
  for (const row of synced.split('\n')) {
    const m = row.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() || '♪' });
  }
  return lines.length ? lines : null;
}

// meta: { title, artist, album, duration } — yalnızca yedek kaynak için kullanılır
export async function lyrics(videoId, meta) {
  const [plain, timed] = await Promise.all([
    plainLyrics(videoId),
    ytmTimedLyrics(videoId).catch(() => null),
  ]);
  let lines = timed;
  let source = plain?.source || '';
  if (!lines) {
    lines = await lrclibLyrics(meta).catch(() => null);
    if (lines) source = 'Kaynak: LRCLIB';
  }
  if (!plain?.text && !lines) return null;
  return {
    text: plain?.text || lines.map((l) => (l.text === '♪' ? '' : l.text)).join('\n'),
    source,
    lines: lines || null,
  };
}

// ---------- kitaplık (giriş gerekli) ----------

async function libraryGrid(browseId) {
  requireLogin();
  let res = await client().actions.execute('/browse', { browseId, client: 'YTMUSIC', parse: true });
  const items = [];
  const grab = (r) => {
    const nodes = [
      ...(r.contents_memo?.getType(YTNodes.MusicTwoRowItem) || []),
      ...(r.contents_memo?.getType(YTNodes.MusicResponsiveListItem) || []),
    ];
    items.push(...normalizeList(nodes));
  };
  grab(res);
  // devam sayfaları
  for (let i = 0; i < 10; i++) {
    const cont =
      res.contents_memo?.getType(YTNodes.ContinuationItem)?.[0] ||
      res.continuation_contents?.continuation ||
      res.on_response_received_actions?.[0]?.contents?.find?.((c) => c.type === 'ContinuationItem');
    const token =
      (typeof cont === 'string' ? cont : null) ||
      cont?.endpoint?.payload?.token ||
      res.continuation_contents?.continuation;
    if (!token) break;
    try {
      res = await client().actions.execute('/browse', { continuation: token, client: 'YTMUSIC', parse: true });
      const before = items.length;
      grab(res);
      if (items.length === before) break;
    } catch {
      break;
    }
  }
  const seen = new Set();
  return items.filter((i) => {
    const k = i.id || i.videoId;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const OWN_LABELS = ['sen', 'siz', 'you'];

export async function libraryPlaylists() {
  const [items, me] = await Promise.all([libraryGrid('FEmusic_liked_playlists'), accountCache || account()]);
  const mine = new Set(
    [me?.name, me?.handle, me?.handle?.replace(/^@/, ''), ...OWN_LABELS]
      .filter(Boolean)
      .map((s) => s.toLocaleLowerCase('tr')),
  );
  // "Yeni oynatma listesi" düğmesi ve Beğenilenler kartını ayıkla; kullanıcının kendi
  // oluşturduklarını (yazarı kendisi olanlar) kaydettiklerinden ayır
  return items
    // VLSE: "Sonra izlenecek bölümler" (podcast listesi) — müzik kitaplığında anlamsız, şarkı da eklenemez
    .filter((i) => i.kind === 'playlist' && i.id && i.id !== 'VLLM' && i.id !== 'VLSE')
    .map((i) => {
      const who = [...(i.subtitle || '').split(' • '), ...(i.artists || []).map((a) => a.name)];
      return { ...i, owned: who.some((w) => w && mine.has(w.trim().toLocaleLowerCase('tr'))) };
    });
}

export async function libraryAlbums() {
  return (await libraryGrid('FEmusic_liked_albums')).filter((i) => i.kind === 'album');
}

export async function libraryArtists() {
  return (await libraryGrid('FEmusic_library_corpus_track_artists')).filter((i) => i.kind === 'artist');
}

export async function likedIds() {
  if (!loggedIn) return [];
  const pl = await playlist('LM', { limit: 2000 });
  return pl.tracks.map((t) => t.videoId);
}

// Hesap işlemleri YouTube Music istemcisiyle (music.youtube.com) yapılmalı. youtubei.js'in
// hazır yardımcıları beğeniyi "TV", liste düzenlemeyi "WEB" istemcisiyle www.youtube.com'a
// gönderiyor; çerezle açılmış oturumda bunlar 400 hatası veriyordu.
async function musicAction(path, body) {
  requireLogin();
  const res = await client().actions.execute(path, { ...body, client: 'YTMUSIC', parse: false });
  const status = res?.data?.status;
  if (status && status !== 'STATUS_SUCCEEDED') throw new Error('YouTube Music isteği reddetti: ' + status);
  return res?.data || {};
}

const plainPlaylistId = (id) => String(id).replace(/^VL/, '');

export async function rate(videoId, liked) {
  await musicAction(liked ? '/like/like' : '/like/removelike', { target: { videoId } });
  return true;
}

export async function addToPlaylist(playlistId, videoIds) {
  const ids = [].concat(videoIds).filter(Boolean);
  if (!ids.length) return true;
  await musicAction('/browse/edit_playlist', {
    playlistId: plainPlaylistId(playlistId),
    actions: ids.map((id) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: id, dedupeOption: 'DEDUPE_OPTION_SKIP' })),
  });
  return true;
}

export async function removeFromPlaylist(playlistId, videoIds) {
  const pid = plainPlaylistId(playlistId);
  const want = new Set([].concat(videoIds));
  // Silmek için listedeki öğenin setVideoId'si gerekiyor
  const pl = await playlist(pid, { limit: 5000 });
  const items = pl.tracks.filter((t) => want.has(t.videoId) && t.setVideoId);
  if (!items.length) throw new Error('Şarkı bu listede bulunamadı');
  await musicAction('/browse/edit_playlist', {
    playlistId: pid,
    actions: items.map((t) => ({ action: 'ACTION_REMOVE_VIDEO', setVideoId: t.setVideoId, removedVideoId: t.videoId })),
  });
  return true;
}

export async function createPlaylist(title, videoIds = []) {
  const data = await musicAction('/playlist/create', {
    title: String(title || 'Yeni çalma listesi'),
    description: '',
    privacyStatus: 'PRIVATE',
    videoIds: [].concat(videoIds).filter(Boolean),
  });
  if (!data.playlistId) throw new Error('Çalma listesi oluşturulamadı');
  return { id: 'VL' + data.playlistId };
}

export async function deletePlaylist(playlistId) {
  await musicAction('/playlist/delete', { playlistId: plainPlaylistId(playlistId) });
  return true;
}

export async function savePlaylist(playlistId, save) {
  await musicAction(save ? '/like/like' : '/like/removelike', { target: { playlistId: plainPlaylistId(playlistId) } });
  return true;
}

let accountCache = null;

export async function account() {
  if (!loggedIn) return { loggedIn: false };
  if (accountCache) return accountCache;
  try {
    accountCache = (await fetchAccount()) || null;
  } catch {}
  return accountCache || { loggedIn: true, name: 'Hesabım', handle: '', photo: null };
}

export const isLoggedIn = () => loggedIn;
