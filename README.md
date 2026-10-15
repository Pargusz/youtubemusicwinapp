# Tını — YouTube Music masaüstü uygulaması

YouTube Music için Spotify tarzı bir Windows masaüstü istemcisi (Electron).

## Özellikler

- Ana sayfa, arama (şarkı / video / albüm / sanatçı / çalma listesi filtreleri), albüm, sanatçı ve tür sayfaları
- Google hesabıyla giriş: beğenilen şarkılar, kendi oluşturduğun ve kaydettiğin çalma listeleri ana sayfada
- Beğenme, çalma listesi oluşturma, listeye şarkı ekleme / çıkarma, kitaplığa kaydetme
- Sıra yönetimi, karışık çalma, tekrar (tümü / tek şarkı), şarkı radyosu
- Zaman damgalı şarkı sözleri: aktif satır vurgulanır, satıra tıklayınca şarkı o saniyeye atlar
- Windows görev çubuğu oynatma düğmeleri ve medya tuşları

## Kurulum

[Node.js](https://nodejs.org) 20 veya üstü gerekir.

```bash
npm install
npm start
```

Windows kurulum dosyası ve taşınabilir sürüm oluşturmak için:

```bash
npm run build
```

Çıktılar `release/` klasörüne yazılır.

## Giriş hakkında

Google, uygulama içine gömülü tarayıcılarla girişi reddettiği için giriş bilgisayardaki Chrome / Edge / Brave'de, uygulamaya ait ayrı bir profille yapılır. Giriş tamamlanınca pencere kendiliğinden kapanır ve oturum uygulamaya aktarılır; kişisel tarayıcı profiline dokunulmaz.

Giriş sorunlarında `%APPDATA%\TiniMusic\tini-log.txt` dosyasına bakılabilir (yalnızca olay ve çerez adlarını içerir, çerez değerlerini içermez).

## Notlar

- Müzik, YouTube Music'in kendi oynatıcısı üzerinden çalınır.
- Bu proje resmi değildir; YouTube veya Google ile bağlantısı yoktur.
