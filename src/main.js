// ============================================================
// BG Remover — client-side video background removal
// Model: MediaPipe Tasks Vision, ImageSegmenter (selfie_segmenter)
// Semua proses jalan di browser (WASM). Tidak ada upload ke server.
// ============================================================

const MAX_FILE_SIZE_MB = 100;
const MAX_DURATION_SEC = 60;
const MAX_OUTPUT_WIDTH = 720; // cap resolusi biar HP Android tidak berat/crash
const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

// Kalau hasil ternyata background yang justru dipertahankan (mask terbalik),
// ubah nilai ini dari 1 ke 0. Ini tergantung label map model yang dipakai.
const FOREGROUND_MASK_VALUE = 0;

// -------- DOM refs --------
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const fileInfo = document.getElementById('fileInfo');
const colorPicker = document.getElementById('colorPicker');
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

  // Cek durasi video sebelum diterima
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

async function runPipeline(file) {
  const segmenter = await loadSegmenter();

  // Siapkan source video
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = URL.createObjectURL(file);
  sourceVideo.src = sourceObjectUrl;
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;

  await new Promise((resolve, reject) => {
    sourceVideo.onloadedmetadata = resolve;
    sourceVideo.onerror = () => reject(new Error('video tidak bisa dibuka'));
  });

  // Hitung ukuran output (cap resolusi untuk performa Android)
  const scale = Math.min(1, MAX_OUTPUT_WIDTH / sourceVideo.videoWidth);
  const outW = Math.round(sourceVideo.videoWidth * scale);
  const outH = Math.round(sourceVideo.videoHeight * scale);
  workCanvas.width = outW;
  workCanvas.height = outH;
  const ctx = workCanvas.getContext('2d', { willReadFrequently: true });

  // Canvas terpisah untuk menggambar mask secara efisien
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = outW;
  maskCanvas.height = outH;
  const maskCtx = maskCanvas.getContext('2d');

  // Setup recorder
  const stream = workCanvas.captureStream(30);
  const mimeType = pickSupportedMimeType();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recordingDone = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  let rafId = null;
  let stopped = false;

  function drawLoop() {
    if (stopped) return;

    if (sourceVideo.paused || sourceVideo.ended) {
      return;
    }

    const timestampMs = performance.now();
    const result = segmenter.segmentForVideo(sourceVideo, timestampMs);
    const mask = result.categoryMask;

    // Gambar frame asli ke canvas kerja
    ctx.drawImage(sourceVideo, 0, 0, outW, outH);
    const frame = ctx.getImageData(0, 0, outW, outH);

    // Ambil data mask dan komposit: foreground asli, background = warna solid
    const maskData = mask.getAsUint8Array();
    const [r, g, b] = hexToRgb(bgColor);
    const pixels = frame.data;

    for (let i = 0; i < maskData.length; i++) {
      const isForeground = maskData[i] === FOREGROUND_MASK_VALUE;
      if (!isForeground) {
        const offset = i * 4;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = 255;
      }
    }

    ctx.putImageData(frame, 0, 0);
    mask.close();

    setProgress((sourceVideo.currentTime / sourceVideo.duration) * 100);

    rafId = requestAnimationFrame(drawLoop);
  }

  sourceVideo.onended = () => {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    setProgress(100);
    recorder.stop();
  };

  recorder.start(250);
  await sourceVideo.play();
  drawLoop();

  await recordingDone;

  // Bangun hasil
  const blob = new Blob(chunks, { type: mimeType });
  resultObjectUrl = URL.createObjectURL(blob);
  resultVideo.src = resultObjectUrl;
  downloadBtn.href = resultObjectUrl;
  downloadBtn.download = `bg-removed-${Date.now()}.webm`;
  resultWrap.classList.remove('hidden');

  // Cleanup
  stream.getTracks().forEach((t) => t.stop());
  URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = null;
  sourceVideo.removeAttribute('src');
}

function pickSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
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

