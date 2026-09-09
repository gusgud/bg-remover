# BG Remover

Website super ringan untuk menghapus background video, 100% berjalan di browser (client-side), tanpa server, tanpa login, tanpa database, tanpa watermark.

## Arsitektur singkat

- **Stack:** Vite + Vanilla JavaScript + HTML/CSS murni (tanpa React/Next.js, tanpa UI library berat).
- **AI Model:** MediaPipe Tasks Vision `ImageSegmenter`, model `selfie_segmenter` (open-source, Apache 2.0, gratis, dari Google). Model & runtime WASM diambil dari CDN publik (`storage.googleapis.com` & `cdn.jsdelivr.net`) hanya saat tombol "Remove Background" ditekan pertama kali (lazy-load) — tidak dimuat di awal supaya halaman tetap ringan dibuka.
- **Proses:** Video diputar diam-diam di elemen `<video>` tersembunyi, tiap frame digambar ke `<canvas>`, disegmentasi (orang vs background), background diganti warna solid pilihan user, lalu `<canvas>` direkam via `MediaRecorder` menjadi file WebM. Semua terjadi di device user — tidak ada video yang dikirim ke server manapun.
- **Kenapa bukan video transparan asli:** `MediaRecorder`/`canvas.captureStream()` di browser saat ini tidak bisa menyimpan alpha channel ke video secara konsisten di Android. Karena itu MVP ini mengganti background dengan warna solid (default hijau, bisa dipilih user) — bukan transparan sungguhan. Ini keputusan sadar demi kompatibilitas, bukan keterbatasan yang disembunyikan.
- **Biaya:** Rp0. Tidak ada API key, tidak ada biaya per-request — compute berjalan di HP/laptop user sendiri. Hosting statis di Vercel/Cloudflare Pages/GitHub Pages juga gratis untuk trafik wajar.
- **Batasan yang sengaja dipasang** (bisa diubah di `src/main.js`):
  - Ukuran file maksimal: 100MB
  - Durasi video maksimal: 60 detik
  - Resolusi output di-cap ke lebar 720px

## Catatan penting soal akurasi mask

Model `selfie_segmenter` mengeluarkan `categoryMask` dengan nilai per-pixel yang menandai foreground/background. Di kode ini, nilai foreground diasumsikan `1` (lihat konstanta `FOREGROUND_MASK_VALUE` di `src/main.js`). **Coba dulu dengan video wajah/orang** — kalau hasilnya malah background yang dipertahankan dan orangnya hilang (mask terbalik), ubah `FOREGROUND_MASK_VALUE` dari `1` ke `0`. Saya tidak punya akses jaringan untuk mengetes model ini secara langsung, jadi ini satu hal yang perlu kamu verifikasi di percobaan pertama.

## Menjalankan secara lokal

```bash
npm install
npm run dev
```

Buka URL yang ditampilkan (biasanya `http://localhost:5173`) di browser. Untuk tes di HP Android via WiFi yang sama, gunakan:

```bash
npm run dev -- --host
```

lalu buka `http://<IP-laptop-kamu>:5173` di HP.

## Build untuk production

```bash
npm run build
```

Hasil build ada di folder `dist/`.

## Deploy ke Vercel

1. Push project ini ke repo GitHub.
2. Buka [vercel.com](https://vercel.com) → New Project → import repo.
3. Framework preset: pilih **Vite** (atau biarkan auto-detect).
4. Build command: `npm run build`, Output directory: `dist`.
5. Tidak ada environment variable yang dibutuhkan.
6. Deploy.

## Deploy ke Cloudflare Pages

1. Push ke GitHub.
2. Cloudflare dashboard → Pages → Create a project → Connect to Git.
3. Build command: `npm run build`, Build output directory: `dist`.
4. Tidak ada environment variable yang dibutuhkan.

## Deploy ke GitHub Pages

1. `npm run build`.
2. Karena `base: './'` sudah diset di `vite.config.js`, isi folder `dist/` bisa langsung di-serve dari path apapun.
3. Push isi `dist/` ke branch `gh-pages`, atau gunakan action `peaceiris/actions-gh-pages`.

## Keamanan & privasi

- Video tidak pernah dikirim/diupload ke server manapun — semua pemrosesan terjadi di browser user.
- Tidak ada penyimpanan permanen; `Blob URL` di-revoke setelah tidak dipakai.
- Validasi tipe file dan ukuran file dilakukan di client sebelum diproses.
- Tidak ada API key yang perlu disembunyikan karena tidak ada pemanggilan API pihak ketiga berbayar.
- 
