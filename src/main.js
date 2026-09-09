// ============================================================
// BG Remover — client-side video background removal
// Model: MediaPipe Tasks Vision, ImageSegmenter (selfie_segmenter)
// Semua proses jalan di browser (WASM). Tidak ada upload ke server.
//
// Catatan performa: video diproses per-frame secara manual (seek + capture),
// BUKAN real-time playback. Ini lebih lambat dari durasi video asli, tapi
// jauh lebih stabil di HP low-end karena tidak ada frame yang ke-skip/telat.
// ============================================================

const MAX_FILE_SIZE_MB = 100;
const MAX_DURATION_SEC = 60;
const MAX_OUTPUT_DIMENSION = 720; // cap sisi terpanjang, biar HP Android tidak berat/crash
const OUTPUT_FPS = 20; // fps lebih rendah = lebih ringan diproses, masih halus untuk hasil akhir
const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

// Nilai kategori foreground pada categoryMask model selfie_segmenter.
// Sudah dikonfirmasi 0 = foreground (orang) pada percobaan sebelumnya.
const FOREGROUND_MASK_VALUE = 0;

const RATIO_MAP = {
  auto: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '9:16': 9 / 16,
  '16:9': 16 / 9
};

// -------- DOM refs --------
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const fileInfo = document.getElementById('fileInfo');
const colorPicker = document.getElementById('colorPicker');
const ratioPicker = document.getElementById('ratioPicker');
const processBtn = document.getElementById('processBtn');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const errorBox = document.getElementById('errorBox');
const resultWrap = document.getElementById('resultWrap');
const resultVideo = document.getElementById('resultVideo');
const downloadBtn = document.getElementById('downloadBtn');
const sourceVideo = document.getElementById('sourceVideo');
const workCanvas = document.getElementById('workCanvas');

// -------- State --------
let selectedFile = null;
let sourceObjectUrl = null;
let resultObjectUrl = null;
let bgColor = '#00ff00';
let selectedRatio = 'auto';
let imageSegmenter = null;
let isProcessing = false;

// -------- UI helpers --------
function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  progressFill.style.width = `${clamped}%`;
  progressLabel.textContent = `${clamped}%`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resetResult() {
  if (resultObjectUrl) {
    URL.revokeObjectURL(resultObjectUrl);
    resultObjectUrl = null;
  }
  resultVideo.removeAttribute('src');
  resultWrap.classList.add('hidden');
  downloadBtn.removeAttribute('href');
}

// -------- File selection --------
uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  clearError();
  resetResult();
  const file = fileInput.files[0];
  if (!file) return;

  if (!ALLOWED_TYPES.includes(file.type)) {
    showError('Format tidak didukung. Gunakan MP4, MOV, atau WebM.');
    fileInput.value = '';
    return;
  }

  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_FILE_SIZE_MB) {
    showError(`File terlalu besar (${sizeMB.toFixed(1)}MB). Maksimal ${MAX_FILE_SIZE_MB}MB.`);
    fileInput.value = '';
    return;
  }

  try {
    const duration = await getVideoDuration(file);
    if (duration > MAX_DURATION_SEC) {
      showError(`Video terlalu panjang (${duration.toFixed(0)}s). Maksimal ${MAX_DURATION_SEC} detik.`);
      fileInput.value = '';
      return;
    }
  } catch (err) {
    showError('Gagal membaca metadata video. Coba file lain.');
    fileInput.value = '';
    return;
  }

  selectedFile = file;
  fileInfo.textContent = `${file.name} — ${formatBytes(file.size)}`;
  fileInfo.classList.remove('hidden');
  colorPicker.classList.remove('hidden');
  ratioPicker.classList.remove('hidden');
  processBtn.classList.remove('hidden');
});

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(probe.duration);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('metadata error'));
    };
    probe.src = url;
  });
}

// -------- Color picker --------
colorPicker.querySelectorAll('.color-swatch').forEach((btn) => {
  btn.addEventListener('click', () => {
    colorPicker.querySelectorAll('.color-swatch').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    bgColor = btn.dataset.color;
  });
});
colorPicker.querySelector('.color-swatch--green').classList.add('selected');

// -------- Ratio picker --------
ratioPicker.querySelectorAll('.ratio-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    ratioPicker.querySelectorAll('.ratio-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedRatio = btn.dataset.ratio;
  });
});

// -------- Lazy-load model (hanya saat dibutuhkan) --------
async function loadSegmenter() {
  if (imageSegmenter) return imageSegmenter;

  const { ImageSegmenter, FilesetResolver } = await import('@mediapipe/tasks-vision');

  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );

  imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
      delegate: 'GPU'
    },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false
  });

  return imageSegmenter;
}

// -------- Main processing pipeline --------
processBtn.addEventListener('click', async () => {
  if (!selectedFile || isProcessing) return;
  clearError();
  resetResult();

  isProcessing = true;
  processBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  setProgress(0);

  try {
    await runPipeline(selectedFile);
  } catch (err) {
    console.error(err);
    showError(`Gagal memproses video: ${err.message || 'terjadi kesalahan tak terduga'}.`);
  } finally {
    isProcessing = false;
    processBtn.disabled = false;
  }
});

// Hitung area crop (di koordinat video asli) supaya sesuai rasio yang dipilih.
function computeCropRect(videoWidth, videoHeight, ratioKey) {
  const targetRatio = RATIO_MAP[ratioKey];
  if (!targetRatio) {
    return { sx: 0, sy: 0, sw: videoWidth, sh: videoHeight };
  }

  const sourceRatio = videoWidth / videoHeight;
  if (sourceRatio > targetRatio) {
    // Video lebih "lebar" dari target -> crop kiri-kanan
    const sw = Math.round(videoHeight * targetRatio);
    const sx = Math.round((videoWidth - sw) / 2);
    return { sx, sy: 0, sw, sh: videoHeight };
  }
  // Video lebih "tinggi"/sempit dari target -> crop atas-bawah
  const sh = Math.round(videoWidth / targetRatio);
  const sy = Math.round((videoHeight - sh) / 2);
  return { sx: 0, sy, sw: videoWidth, sh };
}

function seekTo(video, time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

async function runPipeline(file) {
  const segmenter = await loadSegmenter();

  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = URL.createObjectURL(file);
  sourceVideo.src = sourceObjectUrl;
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;

  await new Promise((resolve, reject) => {
    sourceVideo.onloadedmetadata = resolve;
    sourceVideo.onerror = () => reject(new Error('video tidak bisa dibuka'));
  });

  const crop = computeCropRect(sourceVideo.videoWidth, sourceVideo.videoHeight, selectedRatio);
  const cropRatio = crop.sw / crop.sh;

  let outW;
  let outH;
  if (cropRatio >= 1) {
    outW = MAX_OUTPUT_DIMENSION;
    outH = Math.round(MAX_OUTPUT_DIMENSION / cropRatio);
  } else {
    outH = MAX_OUTPUT_DIMENSION;
    outW = Math.round(MAX_OUTPUT_DIMENSION * cropRatio);
  }
  // Jangan upscale kalau video sumber lebih kecil dari cap
  outW = Math.min(outW, crop.sw);
  outH = Math.min(outH, crop.sh);

  workCanvas.width = outW;
  workCanvas.height = outH;
  const ctx = workCanvas.getContext('2d', { willReadFrequently: true });

  const stream = workCanvas.captureStream(0); // 0 = manual mode, kita kontrol sendiri kapan frame dikirim
  const track = stream.getVideoTracks()[0];
  if (typeof track.requestFrame !== 'function') {
    throw new Error('Browser tidak mendukung mode capture manual. Update Chrome ke versi terbaru.');
  }

  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const recordingDone = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  sourceVideo.pause();
  recorder.start();

  const duration = sourceVideo.duration;
  const frameInterval = 1 / OUTPUT_FPS;
  const totalFrames = Math.max(1, Math.ceil(duration / frameInterval));
  const [r, g, b] = hexToRgb(bgColor);

  for (let f = 0; f < totalFrames; f++) {
    const t = Math.min(f * frameInterval, Math.max(0, duration - 0.02));
    await seekTo(sourceVideo, t);

    const timestampMs = Math.round(t * 1000);
    const result = segmenter.segmentForVideo(sourceVideo, timestampMs);
    const mask = result.categoryMask;
    const maskData = mask.getAsUint8Array();
    const maskW = mask.width;
    const maskH = mask.height;

    ctx.drawImage(sourceVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
    const frame = ctx.getImageData(0, 0, outW, outH);
    const pixels = frame.data;

    for (let y = 0; y < outH; y++) {
      const my = Math.min(maskH - 1, Math.floor((y * maskH) / outH));
      for (let x = 0; x < outW; x++) {
        const mx = Math.min(maskW - 1, Math.floor((x * maskW) / outW));
        const isForeground = maskData[my * maskW + mx] === FOREGROUND_MASK_VALUE;
        if (!isForeground) {
          const offset = (y * outW + x) * 4;
          pixels[offset] = r;
          pixels[offset + 1] = g;
          pixels[offset + 2] = b;
          pixels[offset + 3] = 255;
        }
      }
    }

    ctx.putImageData(frame, 0, 0);
    mask.close();
    track.requestFrame();

    setProgress(((f + 1) / totalFrames) * 100);
    // Kasih browser waktu untuk "napas" tiap beberapa frame biar UI tidak freeze total
    if (f % 3 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  recorder.stop();
  await recordingDone;

  const blob = new Blob(chunks, { type: mimeType });
  resultObjectUrl = URL.createObjectURL(blob);
  resultVideo.src = resultObjectUrl;
  downloadBtn.href = resultObjectUrl;
  downloadBtn.download = `bg-removed-${Date.now()}.webm`;
  resultWrap.classList.remove('hidden');

  stream.getTracks().forEach((t) => t.stop());
  URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = null;
  sourceVideo.removeAttribute('src');
}

function pickSupportedMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  throw new Error('browser tidak mendukung perekaman video (MediaRecorder)');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
        
