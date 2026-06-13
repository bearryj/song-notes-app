// ===== Metronome Engine + Tap Tempo =====
// Self-contained module — owns all metronome state and audio scheduling.

let _$; // DOM helper, set via init()

export function init(getEl) {
  _$ = getEl;
}

// --- State ---
let metroBpm = 120;
let metroTimeSig = 4;
let metroPlaying = false;
let metroBeatIndex = 0;
let metroAudioCtx = null;
let metroNextNoteTime = 0;
let metroTimerID = null;
const metroSchedulerInterval = 25; // ms
const metroLookahead = 100; // ms

// --- Getters for live bindings used in app.js ---
export function isMetroPlaying() { return metroPlaying; }
export function getMetroBpm() { return metroBpm; }

// --- AudioContext ---
function metroGetCtx() {
  if (!metroAudioCtx) {
    metroAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (metroAudioCtx.state === 'suspended') {
    metroAudioCtx.resume();
  }
  return metroAudioCtx;
}

// --- Click synthesis ---
function metroPlayClick(isAccent) {
  const ctx = metroGetCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = isAccent ? 1000 : 800;
  osc.type = 'sine';
  gain.gain.setValueAtTime(isAccent ? 0.5 : 0.35, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.08);
}

function metroVibrate(isAccent) {
  if (navigator.vibrate) {
    navigator.vibrate(isAccent ? [30, 20, 30] : 15);
  }
}

// --- Scheduler ---
function metroScheduleNote() {
  const ctx = metroGetCtx();
  const secondsPerBeat = 60.0 / metroBpm;
  while (metroNextNoteTime < ctx.currentTime + metroLookahead / 1000) {
    const isAccent = (metroBeatIndex % metroTimeSig) === 0;
    metroPlayClick(isAccent);

    // Visual beat
    const beatTime = metroNextNoteTime;
    const delay = Math.max(0, (beatTime - ctx.currentTime) * 1000);
    const capturedIsAccent = isAccent;
    setTimeout(() => {
      const circle = _$('metro-beat-circle');
      if (!circle) return;
      circle.classList.remove('beat', 'beat-accent');
      void circle.offsetWidth; // force reflow
      circle.classList.add(capturedIsAccent ? 'beat-accent' : 'beat');
      metroVibrate(capturedIsAccent);
      setTimeout(() => circle.classList.remove('beat', 'beat-accent'), 100);
    }, delay);

    metroNextNoteTime += secondsPerBeat;
    metroBeatIndex++;
  }
}

// --- Public controls ---
export function metroStart() {
  if (metroPlaying) return;
  metroPlaying = true;
  metroBeatIndex = 0;
  const ctx = metroGetCtx();
  metroNextNoteTime = ctx.currentTime + 0.05;
  metroTimerID = setInterval(metroScheduleNote, metroSchedulerInterval);

  const playBtn = _$('metro-play-btn');
  if (playBtn) {
    playBtn.textContent = '■';
    playBtn.classList.add('playing');
  }
}

export function metroStop() {
  metroPlaying = false;
  if (metroTimerID) {
    clearInterval(metroTimerID);
    metroTimerID = null;
  }
  // Close AudioContext to avoid hitting browser limit (6 on mobile)
  if (metroAudioCtx) {
    try { metroAudioCtx.close(); } catch(e) { /* ignore if already closed */ }
    metroAudioCtx = null;
  }
  const playBtn = _$('metro-play-btn');
  if (playBtn) {
    playBtn.textContent = '▶';
    playBtn.classList.remove('playing');
  }
  const circle = _$('metro-beat-circle');
  if (circle) circle.classList.remove('beat', 'beat-accent');
}

export function metroSetBpm(val) {
  metroBpm = Math.max(30, Math.min(240, val));
  const el = _$('metro-bpm-value');
  if (el) el.textContent = metroBpm;
  const slider = _$('metro-bpm-slider');
  if (slider) slider.value = metroBpm;
  // Update preset active state
  document.querySelectorAll('.metro-preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.bpm) === metroBpm);
  });
}

export function metroSetTimeSig(val) {
  metroTimeSig = val;
  document.querySelectorAll('.metro-time-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.sig) === val);
  });
}

export function showMetronomePanel() {
  const panel = _$('metronome-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  metroSetBpm(metroBpm);
  metroSetTimeSig(metroTimeSig);
  resetTapTempo();

  // Close on backdrop tap
  panel.querySelector('.toolbar-sheet-backdrop').onclick = () => {
    metroStop();
    panel.style.display = 'none';
  };
}

// ===== Tap Tempo =====
let tapTimes = [];
let tapResetTimer = null;
const TAP_MAX_SAMPLES = 8;
const TAP_TIMEOUT = 2000; // ms to reset tap sequence
const TAP_MIN_BPM = 30;
const TAP_MAX_BPM = 240;

function resetTapTempo() {
  tapTimes = [];
  if (tapResetTimer) { clearTimeout(tapResetTimer); tapResetTimer = null; }
  const result = _$('metro-tap-result');
  if (result) { result.textContent = '—'; result.classList.remove('active'); }
}

export function handleTapTempo() {
  const now = performance.now();
  const result = _$('metro-tap-result');
  const btn = _$('metro-tap-btn');
  if (!result) return;

  // Visual feedback
  if (btn) {
    btn.classList.remove('tap-flash');
    void btn.offsetWidth; // force reflow
    btn.classList.add('tap-flash');
  }

  // Reset if too long since last tap
  if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_TIMEOUT) {
    tapTimes = [];
  }

  tapTimes.push(now);

  // Keep only last N samples
  if (tapTimes.length > TAP_MAX_SAMPLES) {
    tapTimes = tapTimes.slice(-TAP_MAX_SAMPLES);
  }

  // Need at least 2 taps to calculate
  if (tapTimes.length < 2) {
    result.textContent = 'tap…';
    result.classList.remove('active');
    // Start reset timer
    if (tapResetTimer) clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(resetTapTempo, TAP_TIMEOUT);
    return;
  }

  // Calculate intervals
  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) {
    intervals.push(tapTimes[i] - tapTimes[i - 1]);
  }

  // Filter out outliers (intervals that are >2x or <0.5x the median)
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const filtered = intervals.filter(iv => iv >= median * 0.4 && iv <= median * 2.5);

  if (filtered.length === 0) {
    result.textContent = 'tap…';
    result.classList.remove('active');
    if (tapResetTimer) clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(resetTapTempo, TAP_TIMEOUT);
    return;
  }

  const avgInterval = filtered.reduce((a, b) => a + b, 0) / filtered.length;
  let bpm = Math.round(60000 / avgInterval);
  bpm = Math.max(TAP_MIN_BPM, Math.min(TAP_MAX_BPM, bpm));

  result.textContent = `${bpm} BPM`;
  result.classList.add('active');

  // Auto-apply to metronome
  metroSetBpm(bpm);

  // Reset timer
  if (tapResetTimer) clearTimeout(tapResetTimer);
  tapResetTimer = setTimeout(resetTapTempo, TAP_TIMEOUT);
}
