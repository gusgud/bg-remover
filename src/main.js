// ============================================================
// BG Remover — client-side video background removal
// Model: MediaPipe Tasks Vision, ImageSegmenter (selfie_segmenter)
// Encoding: WebCodecs VideoEncoder + webm-muxer (timestamp per-frame eksplisit,
// supaya kecepatan playback hasil tetap benar walau proses di HP lambat)
// Semua proses jalan di browser. Tidak ada upload ke server.
// ============================================================

import { Muxer, ArrayBufferTarget } from 'webm-muxer';

const MAX_FILE_SIZE_MB = 100;
const MAX_DURATION_SEC = 60;
// Tidak ada cap resolusi — output memakai resolusi asli video (setelah crop rasio).
// Konsekuensinya: proses lebih berat/lambat di HP untuk video resolusi tinggi,
// dan ukuran file hasil lebih besar.
const OUTPUT_FPS = 15; // fps lebih rendah = lebih ringan & lebih stabil di HP low-end
const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

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
    outputCategoryMask: false,
    outputConfidenceMasks: true // pakai nilai 0..1 (bukan biner) supaya tepi bisa dihaluskan
  });

  return imageSegmenter;
}

// -------- Main processing pipeline --------
processBtn.addEventListener('click', async () => {
  if (!selectedFile || isProcessing) return;
  clearError();
  resetResult();

  if (typeof VideoEncoder === 'undefined') {
    showError('Browser ini tidak mendukung WebCodecs. Update Chrome ke versi terbaru dari Play Store.');
    return;
  }

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
    const sw = Math.round(videoHeight * targetRatio);
    const sx = Math.round((videoWidth - sw) / 2);
    return { sx, sy: 0, sw, sh: videoHeight };
  }
  const sh = Math.round(videoWidth / targetRatio);
  const sy = Math.round((videoHeight - sh) / 2);
  return { sx: 0, sy, sw: videoWidth, sh };
}

function makeEven(n) {
  return n % 2 === 0 ? n : n - 1;
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

  // Output memakai resolusi hasil crop apa adanya (tidak di-downscale).
  const outW = makeEven(crop.sw);
  const outH = makeEven(crop.sh);

  workCanvas.width = outW;
  workCanvas.height = outH;
  const ctx = workCanvas.getContext('2d', { willReadFrequently: true });

  // -------- Setup encoder + muxer (timing frame dikontrol manual & pasti) --------
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'V_VP9',
      width: outW,
      height: outH,
      frameRate: OUTPUT_FPS
    }
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => console.error('encoder error', e)
  });

  // Bitrate mengikuti jumlah pixel supaya video resolusi tinggi tidak jadi buram
  const estimatedBitrate = Math.min(20_000_000, Math.round(outW * outH * OUTPUT_FPS * 0.07));
  encoder.configure({
    codec: 'vp09.00.10.08',
    width: outW,
    height: outH,
    bitrate: estimatedBitrate,
    framerate: OUTPUT_FPS
  });

  sourceVideo.pause();

  const duration = sourceVideo.duration;
  const frameDurationSec = 1 / OUTPUT_FPS;
  const frameDurationUs = Math.round(1_000_000 / OUTPUT_FPS);
  const totalFrames = Math.max(1, Math.ceil(duration / frameDurationSec));
  const [r, g, b] = hexToRgb(bgColor);

  for (let f = 0; f < totalFrames; f++) {
    const t = Math.min(f * frameDurationSec, Math.max(0, duration - 0.02));
    await seekTo(sourceVideo, t);

    const timestampMs = Math.round(t * 1000);
    const result = segmenter.segmentForVideo(sourceVideo, timestampMs);
    const mask = result.confidenceMasks[0];
    const maskData = mask.getAsFloat32Array(); // 0.0 (background) - 1.0 (orang)
    const maskW = mask.width;
    const maskH = mask.height;

    ctx.drawImage(sourceVideo, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
    const frame = ctx.getImageData(0, 0, outW, outH);
    const pixels = frame.data;

    for (let y = 0; y < outH; y++) {
      const my = Math.min(maskH - 1, Math.floor((y * maskH) / outH));
      for (let x = 0; x < outW; x++) {
        const mx = Math.min(maskW - 1, Math.floor((x * maskW) / outW));
        const alpha = maskData[my * maskW + mx]; // 1 = penuh orang, 0 = penuh background
        const offset = (y * outW + x) * 4;
        if (alpha < 0.98) {
          const bgWeight = 1 - alpha;
          pixels[offset] = pixels[offset] * alpha + r * bgWeight;
          pixels[offset + 1] = pixels[offset + 1] * alpha + g * bgWeight;
          pixels[offset + 2] = pixels[offset + 2] * alpha + b * bgWeight;
        }
      }
    }

    ctx.putImageData(frame, 0, 0);
    mask.close();

    const videoFrame = new VideoFrame(workCanvas, {
      timestamp: f * frameDurationUs,
      duration: frameDurationUs
    });
    encoder.encode(videoFrame, { keyFrame: f % (OUTPUT_FPS * 2) === 0 });
    videoFrame.close();

    setProgress(((f + 1) / totalFrames) * 100);
    if (f % 3 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const { buffer } = muxer.target;
  const blob = new Blob([buffer], { type: 'video/webm' });
  resultObjectUrl = URL.createObjectURL(blob);
  resultVideo.src = resultObjectUrl;
  downloadBtn.href = resultObjectUrl;
  downloadBtn.download = `bg-removed-${Date.now()}.webm`;
  resultWrap.classList.remove('hidden');

  URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = null;
  sourceVideo.removeAttribute('src');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
