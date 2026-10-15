// npm install sonrası youtubei.js'e iki küçük düzeltme uygular (tekrar çalıştırılması güvenlidir).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'youtubei.js');
if (!fs.existsSync(root)) process.exit(0);

// 1) Paketlenmiş sürümde "bugs" alanı silinince ayrıştırıcının uyarı kodu hata fırlatıyordu
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
if (!pkg.bugs) {
  pkg.bugs = { url: 'https://github.com/LuanRT/YouTube.js/issues' };
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
}

// 2) Listeden şarkı silmek için gereken playlistSetVideoId değeri nesneye kaydedilmiyordu
const itemFile = path.join(root, 'dist', 'src', 'parser', 'classes', 'MusicResponsiveListItem.js');
let src = fs.readFileSync(itemFile, 'utf8');
const marker = 'this.playlist_set_video_id = playlist_item_data.playlist_set_video_id;';
if (!src.includes(marker)) {
  const anchor = "playlist_set_video_id: data?.playlistItemData?.playlistSetVideoId || null\n        };";
  if (!src.includes(anchor)) {
    console.warn('[patch-youtubei] MusicResponsiveListItem.js beklenen biçimde değil, düzeltme atlandı');
  } else {
    src = src.replace(anchor, anchor + '\n        ' + marker);
    fs.writeFileSync(itemFile, src);
  }
}
