// ===== Song Notes Mobile — Apple Notes Style =====

import { invoke } from '@tauri-apps/api/core';
import { init as metroInit, isMetroPlaying, getMetroBpm, metroStart, metroStop, metroSetBpm, metroSetTimeSig, showMetronomePanel, handleTapTempo } from './modules/metro.js';

let isTauri = false;
let songs = [];
let folders = ['All Songs'];
let currentFolder = 'All Songs';
let currentSongId = null;
let viewStack = ['folder-view'];
let autoSaveTimer = null;
let localStorageWriteTimer = null; // debounced localStorage flush for songs array
let versionHistory = [];
let mediaRecorder = null;
let recordingStream = null;
let audioChunks = [];
let isRecording = false;
let audioPlayer = new Audio();
let hasChanges = false;

// ===== Reduced Motion =====
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

// ===== View State =====
let galleryMode = localStorage.getItem('sn_gallery_mode') === 'true';
let chordRibbonCollapsed = localStorage.getItem('chordRibbonCollapsed') === 'true';
let focusMode = localStorage.getItem('sn_focusMode') === 'true';
let currentPlayingSongId = null;
let displayMode = localStorage.getItem('sn_displayMode') || 'both'; // 'both' | 'lyrics' | 'chords'
let editorFontSize = parseInt(localStorage.getItem('sn_editorFontSize')) || 17; // lyric font size in px, range 13-24
let typewriterScroll = localStorage.getItem('sn_typewriterScroll') === 'true'; // keep active line centered while typing
let currentSearchFilter = ''; // active search query for highlighting in virtual scroll re-renders

// ===== Haptic Feedback =====
function haptic(ms = 15) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ===== Feature Discovery Hints =====
// Tracks which one-time hints have been shown. Persisted to localStorage.
let featureHints = {};
try { featureHints = JSON.parse(localStorage.getItem('sn_feature_hints') || '{}'); } catch {}
function markHintShown(name) {
  featureHints[name] = true;
  safeStorageSet('sn_feature_hints', JSON.stringify(featureHints));
}

// ===== Recent Chords =====
// Tracks the last 8 unique chords the user has confirmed, persisted to localStorage.
// Most-recent first. Used to populate a quick-access row in the chord edit popup.
function getRecentChords() {
  try { return JSON.parse(localStorage.getItem('sn_recent_chords') || '[]'); } catch { return []; }
}
function addRecentChord(name) {
  if (!name) return;
  let recent = getRecentChords();
  recent = recent.filter(c => c !== name);
  recent.unshift(name);
  if (recent.length > 8) recent.length = 8;
  safeStorageSet('sn_recent_chords', JSON.stringify(recent));
}

// ===== Offline / Sync Queue State =====
let isOnline = navigator.onLine;
let syncQueue = []; // queued save operations while offline
let syncQueueTimer = null; // debounce timer for queue flush

// ===== Trash State =====
let trash = []; // { song, deletedAt: ISO8601 }

// ===== Session Timer State =====
let sessionStartTime = null;
let sessionTimerInterval = null;
let sessionTotalMs = 0; // accumulated ms from previous sessions (from song.session_ms)

// ===== Virtual Scroll State =====
// For list mode: flat array of { type: 'header'|'song', data, height, offset }
let virtualItems = [];
let virtualScrollInitialized = false;
let virtualScrollRAF = null;
const VIRTUAL_BUFFER = 8; // extra items to render above/below viewport
const ITEM_HEIGHT = 52;   // estimated song row height (px)
const HEADER_HEIGHT = 31;  // estimated section header height (px)

// ===== Setlist State =====
let setlists = [];
let activeSetlistId = null;

// ===== Song List Delegation State =====
// Track swipe state per swipe-item element (avoids per-item listeners)
const swipeState = new WeakMap();

// ===== Multi-Select State =====
let multiSelectMode = false;
let selectedSongIds = new Set();

// Chord definitions
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROMATIC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function noteToSemitone(note) {
  const idx = CHROMATIC.indexOf(note.toUpperCase());
  return idx !== -1 ? idx : CHROMATIC_FLAT.indexOf(note.toUpperCase());
}

function semitoneToNote(s) {
  return CHROMATIC[((s % 12) + 12) % 12];
}

function transposeChord(name, semitones) {
  if (!name || !name.trim()) return name;
  const m = name.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return name;
  const note = m[1], suffix = m[2];
  const idx = noteToSemitone(note);
  return idx === -1 ? name : semitoneToNote(idx + semitones) + suffix;
}

function transposeSong(song, semitones) {
  if (!song) return;
  song.sections.forEach(s => s.lines.forEach(l => l.chords.forEach(c => { c.name = transposeChord(c.name, semitones); })));
  const km = song.key?.match(/^([A-G][#b]?)(.*)$/);
  if (km) { const i = noteToSemitone(km[1]); if (i !== -1) song.key = semitoneToNote(i + semitones) + km[2]; }
}

// DOM
const $ = id => document.getElementById(id);

// Navigation
function showView(id, direction) {
  const views = document.querySelectorAll('.view');
  const target = $(id);
  if (!target) return;

  if (!direction) {
    // Plain switch (no animation)
    views.forEach(v => {
      v.classList.remove('active', 'sliding-out-left', 'sliding-out-right', 'slide-in-left', 'slide-in-right');
    });
    target.classList.remove('slide-in-left', 'slide-in-right');
    target.classList.add('active');
    return;
  }

  // Find currently active view
  let current = null;
  views.forEach(v => { if (v.classList.contains('active')) current = v; });

  if (!current || current === target) {
    views.forEach(v => v.classList.remove('active', 'sliding-out-left', 'sliding-out-right', 'slide-in-left', 'slide-in-right'));
    target.classList.remove('slide-in-left', 'slide-in-right');
    target.classList.add('active');
    return;
  }

  // Clear any lingering transition classes
  views.forEach(v => v.classList.remove('slide-in-left', 'slide-in-right'));

  const isForward = direction === 'forward';

  // Position incoming view off-screen (left for back, right for forward) — no transition
  target.classList.add(isForward ? 'slide-in-right' : 'slide-in-left');

  // Force reflow so the browser registers the starting position
  void target.offsetWidth;

  // Apply sliding-out to current view
  current.classList.add(isForward ? 'sliding-out-left' : 'sliding-out-right');

  // Trigger incoming view to slide to center (inline transition overrides class)
  target.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease';
  target.style.opacity = '0.6';
  target.style.transform = 'translateX(0)';
  target.classList.remove('slide-in-left', 'slide-in-right');

  // After animation completes
  const onEnd = () => {
    target.removeEventListener('transitionend', onEnd);
    target.style.transition = '';
    target.style.opacity = '';
    target.style.transform = '';
    views.forEach(v => {
      if (v !== target) v.classList.remove('active', 'sliding-out-left', 'sliding-out-right');
    });
    target.classList.add('active');
  };
  target.addEventListener('transitionend', onEnd);
  // Fallback in case transitionend doesn't fire
  setTimeout(onEnd, 420);
}

let pushCallback = null;
function pushView(id, callback) {
  viewStack.push(id);
  showView(id, 'forward');
  pushCallback = callback;
}
function popView() {
  if (viewStack.length > 1) {
    viewStack.pop();
    showView(viewStack[viewStack.length - 1], 'back');
    if (pushCallback) { pushCallback(); pushCallback = null; }
  }
  // Exit focus mode when leaving editor
  if (focusMode) {
    focusMode = false;
    safeStorageSet('sn_focusMode', 'false');
    applyFocusMode();
  }
}

// Tauri
async function initTauri() {
  try { await invoke('ensure_data_dir'); isTauri = true; } catch (e) { isTauri = false; }
}
async function tauriLoadSongs() { try { return await invoke('load_songs') || []; } catch { return null; } }
async function tauriSaveSong(s) { try { await invoke('save_song', { song: s }); return true; } catch { return false; } }
async function tauriDeleteSong(id) { try { await invoke('delete_song', { id }); return true; } catch { return false; } }
async function tauriLoadFolders() { try { return await invoke('load_folders'); } catch { return null; } }
async function tauriSaveFolders(f) { try { await invoke('save_folders', { folders: f }); return true; } catch { return false; } }

// Persistence
async function loadSongs() {
  if (isTauri) { const r = await tauriLoadSongs(); if (r && r.length) { songs = r; return; } }
  try { songs = JSON.parse(localStorage.getItem('songs_app')) || []; } catch { songs = []; }
  // Load trash
  try { trash = JSON.parse(localStorage.getItem('sn_trash')) || []; } catch { trash = []; }
}

// Pull-to-refresh: reload data from storage and re-render
async function refreshSongData() {
  // Show skeleton while refreshing
  showSongListSkeletonStaggered(6);
  // Re-load songs from source of truth
  if (isTauri) {
    const r = await tauriLoadSongs();
    if (r) songs = r;
  } else {
    try { songs = JSON.parse(localStorage.getItem('songs_app')) || []; } catch { songs = []; }
  }
  // Re-load folders (Tauri + localStorage)
  try { const s = JSON.parse(localStorage.getItem('folders_app')); if (s?.length) folders = s; } catch {}
  if (isTauri) { const bf = await tauriLoadFolders(); if (bf?.length) folders = bf; }
  // Re-render
  renderFolders();
  renderSongList($('search-input')?.value || '');

  // If in editor, refresh editor body
  if (currentSongId) {
    const song = getSong(currentSongId);
    if (song) {
      renderEditorBody(song);
      updateRecordUI();
    }
  }
}

async function saveSongs() {
  queueLocalStorageSave();
  if (isTauri) for (const s of songs) await tauriSaveSong(s);
}

// Debounced localStorage write — batches rapid saves into a single write
const LS_WRITE_DELAY = 2000; // 2s debounce window
function queueLocalStorageSave() {
  clearTimeout(localStorageWriteTimer);
  localStorageWriteTimer = setTimeout(() => {
    localStorageWriteTimer = null;
    safeStorageSet('songs_app', JSON.stringify(songs));
  }, LS_WRITE_DELAY);
}
// Synchronous flush — call before page unload / emergency save
function flushLocalStorage() {
  clearTimeout(localStorageWriteTimer);
  localStorageWriteTimer = null;
  safeStorageSet('songs_app', JSON.stringify(songs));
}

// Safe localStorage write — wraps setItem in try/catch with quota detection.
// Shows a single toast per session when quota is exceeded so the user knows
// to delete old recordings or exported data.
let _quotaWarned = false;
function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    const isQuota = e.name === 'QuotaExceededError' ||
      e.code === 22 || e.code === 1014 ||
      /quota/i.test(e.message || '');
    if (isQuota && !_quotaWarned) {
      _quotaWarned = true;
      toast('Storage full — delete old recordings to free space', 'error');
    }
  }
}

function saveTrash() {
  safeStorageSet('sn_trash', JSON.stringify(trash));
}
async function saveSingleSong(song) {
  if (!song) return;
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song; else songs.unshift(song);
  queueLocalStorageSave();
  if (isTauri) {
    if (isOnline) {
      await tauriSaveSong(song);
    } else {
      enqueueSync('save', song);
    }
  }
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function createSong(title) {
  return {
    id: generateId(), title: title || 'Untitled', key: '', bpm: null, time_sig: null,
    tags: [], folder: currentFolder === 'All Songs' ? null : currentFolder,
    sections: [{ type: 'Verse', strumming: null, lines: [{ text: '', chords: [] }] }],
    audio: [], pinned: false, notes: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

function getSong(id) { return songs.find(s => s.id === id); }

// ===== HTML Template Helpers =====
// Reusable empty-state renderer — replaces ad-hoc innerHTML concatenation
function emptyStateHTML({ iconSvg, title, desc, cta }) {
  return `<div class="empty-state"><div class="empty-icon">${iconSvg}</div><h2>${escHtml(title)}</h2><p>${escHtml(desc)}</p>${cta || ''}</div>`;
}

// SVG icon constants — shared across empty states
const ICONS = {
  music: '<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M58 18v32c0 6-5 11-11 11s-11-5-11-11 5-11 11-11c2 0 4 .5 6 1.5V18L30 24v32c0 6-5 11-11 11S8 62 8 56s5-11 11-11c2 0 4 .5 6 1.5V24l33-6z" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="19" cy="56" r="2" fill="currentColor" opacity="0.5"/><circle cx="47" cy="44" r="2" fill="currentColor" opacity="0.5"/></svg>',
  search: '<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="22" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><line x1="52" y1="52" x2="68" y2="68" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M26 36h20M36 26v20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.4"/></svg>',
  setlist: '<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="14" width="56" height="8" rx="2" stroke="currentColor" stroke-width="2" opacity="0.4"/><rect x="12" y="30" width="40" height="8" rx="2" stroke="currentColor" stroke-width="2" opacity="0.6"/><rect x="12" y="46" width="48" height="8" rx="2" stroke="currentColor" stroke-width="2" opacity="0.5"/><rect x="12" y="62" width="30" height="8" rx="2" stroke="currentColor" stroke-width="2" opacity="0.3"/><circle cx="60" cy="34" r="10" stroke="currentColor" stroke-width="2" opacity="0.5"/><path d="M56 34h8M60 30v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>',
  setlistAdd: '<svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M28 20v40M52 20v40M28 20c0 0 8-4 12-4s12 4 12 4M28 60c0 0 8 4 12 4s12-4 12-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity="0.4"/><circle cx="40" cy="40" r="8" stroke="currentColor" stroke-width="2" opacity="0.5"/><path d="M37 40h6M40 37v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>',
};

// ===== Input Sheet (replaces prompt()) =====
// Usage: showInputSheet({ title, placeholder, initialValue, onConfirm(value) })
// Returns a Promise that resolves to the entered value or null if cancelled
function showInputSheet({ title, placeholder, initialValue = '', onConfirm }) {
  const sheet = document.createElement('div');
  sheet.className = 'input-sheet';
  sheet.innerHTML = `
    <div class="input-sheet-backdrop"></div>
    <div class="input-sheet-content">
      <div class="input-sheet-handle"></div>
      <div class="input-sheet-title">${escHtml(title)}</div>
      <input type="text" class="input-sheet-field" placeholder="${escHtml(placeholder || '')}" value="${escHtml(initialValue)}" spellcheck="false">
      <div class="input-sheet-actions">
        <button class="input-sheet-cancel">Cancel</button>
        <button class="input-sheet-confirm">Done</button>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  enableDragToDismiss(sheet, { contentSelector: '.input-sheet-content', backdropSelector: '.input-sheet-backdrop', onDismiss: () => { sheet._close = null; } });

  const input = sheet.querySelector('.input-sheet-field');
  const confirmBtn = sheet.querySelector('.input-sheet-confirm');
  const cancelBtn = sheet.querySelector('.input-sheet-cancel');
  const backdrop = sheet.querySelector('.input-sheet-backdrop');

  const close = () => sheet.remove();
  sheet._close = close;

  const doConfirm = () => {
    const val = input.value.trim();
    close();
    if (val && onConfirm) onConfirm(val);
  };

  cancelBtn.onclick = close;
  backdrop.onclick = close;
  confirmBtn.onclick = doConfirm;
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); doConfirm(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  setTimeout(() => input.focus(), 100);
  return sheet;
}

// ===== Confirm Sheet (replaces confirm()) =====
// Usage: showConfirmSheet({ title, body, confirmText, confirmClass, onConfirm })
function showConfirmSheet({ title, body, confirmText = 'Confirm', confirmClass = '', onConfirm }) {
  const sheet = document.createElement('div');
  sheet.className = 'confirm-sheet';
  sheet.innerHTML = `
    <div class="confirm-sheet-backdrop"></div>
    <div class="confirm-sheet-content">
      <div class="confirm-sheet-handle"></div>
      <div class="confirm-sheet-title">${escHtml(title)}</div>
      ${body ? `<div class="confirm-sheet-body">${escHtml(body)}</div>` : ''}
      <div class="confirm-sheet-actions">
        <button class="confirm-sheet-cancel">Cancel</button>
        <button class="confirm-sheet-confirm ${confirmClass}">${escHtml(confirmText)}</button>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  enableDragToDismiss(sheet, { contentSelector: '.confirm-sheet-content', backdropSelector: '.confirm-sheet-backdrop' });

  const confirmBtn = sheet.querySelector('.confirm-sheet-confirm');
  const cancelBtn = sheet.querySelector('.confirm-sheet-cancel');
  const backdrop = sheet.querySelector('.confirm-sheet-backdrop');

  const close = () => sheet.remove();
  cancelBtn.onclick = close;
  backdrop.onclick = close;
  confirmBtn.onclick = () => { close(); if (onConfirm) onConfirm(); };

  setTimeout(() => confirmBtn.focus(), 100);
  return sheet;
}

// ===== Key Picker (circle-of-fifths grid) =====
const KEYS_SHARP = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
const KEYS_FLAT  = ['C', 'G', 'D', 'A', 'E', 'B', 'Gb', 'Db', 'Ab', 'Eb', 'Bb'];
const KEY_LABELS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#/Gb', 'C#/Db', 'G#/D#', 'D#/Eb', 'A#/Bb'];
const KEY_ROMAN = ['I', 'V', 'ii', 'vi', 'iii', 'vii°', 'IV', '♭VII', '♭III', '♭VI'];

function showKeyPicker(song) {
  const sheet = document.createElement('div');
  sheet.className = 'key-picker';
  sheet.innerHTML = `
    <div class="key-picker-backdrop"></div>
    <div class="key-picker-content">
      <div class="key-picker-handle"></div>
      <div class="key-picker-title">Transpose Song</div>
      <div class="key-picker-current">Current: <strong>${esc(song.key || '—')}</strong></div>
      <div class="key-picker-section-label">Major Keys</div>
      <div class="key-picker-grid">
        ${KEY_LABELS.map((k, i) => `<button class="key-picker-btn ${k.replace(/\/.*/, '').replace('#', '') === (song.key || '').replace(/[^A-Gb#]/g, '') ? 'active' : ''}" data-key="${KEYS_SHARP[i]}" data-type="major"><span class="key-name">${k}</span></button>`).join('')}
      </div>
      <div class="key-picker-actions">
        <button class="key-picker-transpose-down">♭ Down 1</button>
        <button class="key-picker-transpose-up">Up 1 ♯</button>
      </div>
      <div class="key-picker-close-wrap">
        <button class="key-picker-close">Close</button>
      </div>
    </div>`;

  document.body.appendChild(sheet);
  enableDragToDismiss(sheet, { contentSelector: '.key-picker-content', backdropSelector: '.key-picker-backdrop' });

  const close = () => sheet.remove();
  sheet.querySelector('.key-picker-backdrop').onclick = close;
  sheet.querySelector('.key-picker-close').onclick = close;

  // Key selection
  sheet.querySelectorAll('.key-picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetKey = btn.dataset.key;
      const semitones = calcSemitones(song.key || 'C', targetKey);
      pushVersion();
      transposeSong(song, semitones);
      saveSingleSong(song);
      renderEditorBody(song);
      renderSongList();
      updateEditorKeyBpm(song);
      close();
      toast(`Transposed to ${targetKey}`);
    });
  });

  // Quick transpose buttons
  sheet.querySelector('.key-picker-transpose-down').addEventListener('click', () => {
    pushVersion(); transposeSong(song, -1); saveSingleSong(song);
    renderEditorBody(song); renderSongList(); updateEditorKeyBpm(song); close(); toast('♭');
  });
  sheet.querySelector('.key-picker-transpose-up').addEventListener('click', () => {
    pushVersion(); transposeSong(song, 1); saveSingleSong(song);
    renderEditorBody(song); renderSongList(); updateEditorKeyBpm(song); close(); toast('♯');
  });
}

// Compact key+BPM quick-action sheet (tapped from editor nav badge)
function showKeyBpmSheet(song) {
  const sheet = document.createElement('div');
  sheet.className = 'key-bpm-sheet';
  sheet.innerHTML = `
    <div class="toolbar-sheet-backdrop"></div>
    <div class="toolbar-sheet-content">
      <div class="toolbar-sheet-handle"></div>
      <div class="key-bpm-sheet-title">Song Settings</div>
      <div class="key-bpm-row">
        <div class="key-bpm-label">Key</div>
        <div class="key-bpm-value" id="kbpms-key">${esc(song.key || '—')}</div>
        <button class="key-bpm-change-btn" id="kbpms-change-key">Change</button>
      </div>
      <div class="key-bpm-row">
        <div class="key-bpm-label">BPM</div>
        <div class="key-bpm-value" id="kbpms-bpm">${esc(song.bpm ? String(song.bpm) : '—')}</div>
        <button class="key-bpm-change-btn" id="kbpms-change-bpm">Change</button>
      </div>
      <div class="key-bpm-row">
        <div class="key-bpm-label">Capo</div>
        <div class="key-bpm-value" id="kbpms-capo">${song.capo || 0}</div>
        <div class="key-bpm-capo-btns">
          <button class="key-bpm-capo-btn" id="kbpms-capo-down" title="Decrease capo">−</button>
          <button class="key-bpm-capo-btn" id="kbpms-capo-up" title="Increase capo">+</button>
        </div>
      </div>
      <div class="key-bpm-transpose-row">
        <button class="key-bpm-transpose-btn" id="kbpms-trans-down">♭ Down 1</button>
        <button class="key-bpm-transpose-btn" id="kbpms-trans-up">Up 1 ♯</button>
      </div>
    </div>`;
  document.body.appendChild(sheet);
  enableDragToDismiss(sheet, { contentSelector: '.toolbar-sheet-content', backdropSelector: '.toolbar-sheet-backdrop' });

  const close = () => sheet.remove();
  sheet.querySelector('.toolbar-sheet-backdrop').onclick = close;

  // Change key → open full key picker
  sheet.querySelector('#kbpms-change-key').onclick = () => { close(); showKeyPicker(song); };
  // Change BPM → open input sheet
  sheet.querySelector('#kbpms-change-bpm').onclick = () => {
    close();
    showInputSheet({
      title: 'Set BPM',
      placeholder: 'e.g. 120',
      initialValue: song.bpm ? String(song.bpm) : '',
      onConfirm: (bpm) => { song.bpm = parseInt(bpm) || null; saveSingleSong(song); updateEditorKeyBpm(song); }
    });
  };
  // Capo up/down
  const updateCapoDisplay = () => {
    sheet.querySelector('#kbpms-capo').textContent = song.capo || 0;
    updateEditorKeyBpm(song);
  };
  sheet.querySelector('#kbpms-capo-down').onclick = () => {
    song.capo = Math.max(0, (song.capo || 0) - 1);
    saveSingleSong(song);
    updateCapoDisplay();
  };
  sheet.querySelector('#kbpms-capo-up').onclick = () => {
    song.capo = Math.min(11, (song.capo || 0) + 1);
    saveSingleSong(song);
    updateCapoDisplay();
  };
  // Quick transpose
  sheet.querySelector('#kbpms-trans-down').onclick = () => {
    pushVersion(); transposeSong(song, -1); saveSingleSong(song);
    renderEditorBody(song); renderSongList(); updateEditorKeyBpm(song);
    close(); toast('♭');
  };
  sheet.querySelector('#kbpms-trans-up').onclick = () => {
    pushVersion(); transposeSong(song, 1); saveSingleSong(song);
    renderEditorBody(song); renderSongList(); updateEditorKeyBpm(song);
    close(); toast('♯');
  };
}

// Calculate semitone distance from one key to another
function calcSemitones(fromKey, toKey) {
  const fromRoot = fromKey ? fromKey.replace(/[^A-Gb#]/g, '').trim() : 'C';
  const toRoot = toKey.replace(/[^A-Gb#]/g, '');
  const fromIdx = noteToSemitone(fromRoot);
  const toIdx = noteToSemitone(toRoot);
  if (fromIdx === -1 || toIdx === -1) return 0;
  return ((toIdx - fromIdx) % 12 + 12) % 12;
}

function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function computeAudioSize(song) {
  if (!song.audio || !song.audio.length) return 0;
  let total = 0;
  song.audio.forEach(rec => {
    if (rec.data) {
      // base64 string length * 0.75 gives approximate decoded byte size
      // but we care about storage size, so use the string length directly
      total += rec.data.length;
    }
  });
  return total;
}

// ===== Drag to Dismiss for Bottom Sheets =====
// Adds touch drag-to-dismiss behavior to a sheet element.
// The sheet slides down and fades out when dragged downward past a threshold.
// Options:
//   contentSelector  — selector for the draggable content container (first child found)
//   backdropSelector — selector for the backdrop element (fades out during drag)
//   threshold        — px of downward drag before snap-dismiss (default 80)
//   onDismiss        — callback after dismiss animation completes
function enableDragToDismiss(sheet, { contentSelector = null, backdropSelector = null, threshold = 80, onDismiss = null } = {}) {
  const content = contentSelector ? sheet.querySelector(contentSelector) : sheet.children[0];
  const backdrop = backdropSelector ? sheet.querySelector(backdropSelector) : null;
  if (!content) return;

  let startY = 0, startX = 0, currentY = 0, isDragging = false, isDragDismiss = false;
  const DRAG_THRESHOLD = 6; // px before we decide it's a drag vs tap

  const onTouchStart = (e) => {
    // Only start drag from the handle area (top 40px of content) or if scrolling at top
    const touch = e.touches[0];
    startY = touch.clientY;
    startX = touch.clientX;
    currentY = touch.clientY;
    isDragging = false;
    isDragDismiss = false;
  };

  const onTouchMove = (e) => {
    const touch = e.touches[0];
    const diffY = touch.clientY - startY;
    const diffX = Math.abs(touch.clientX - startX);

    // Only engage vertical drag if clearly vertical and downward
    if (!isDragging && diffY > DRAG_THRESHOLD && diffY > diffX * 0.7) {
      isDragging = true;
      isDragDismiss = true;
      content.classList.add('sheet-dragging');
      if (backdrop) backdrop.style.transition = 'opacity 0.1s ease';
    }

    if (!isDragDismiss) return;

    // Prevent other gestures while dragging to dismiss
    if (diffY > 0) e.preventDefault();

    const offset = Math.max(0, touch.clientY - startY);
    currentY = touch.clientY;
    content.style.transform = `translateY(${offset}px)`;
    content.style.animation = 'none';

    // Fade backdrop proportionally
    if (backdrop) {
      const backdropOpacity = Math.max(0, 1 - offset / (threshold * 2));
      backdrop.style.opacity = backdropOpacity;
    }
  };

  const onTouchEnd = () => {
    if (!isDragDismiss) {
      isDragging = false;
      return;
    }

    const diffY = currentY - startY;
    content.classList.remove('sheet-dragging');

    if (diffY > threshold) {
      // Dismiss: slide down + fade backdrop
      content.classList.add('sheet-drag-dismiss');
      if (backdrop) {
        backdrop.style.transition = 'opacity 0.25s ease';
        backdrop.style.opacity = '0';
      }
      content.addEventListener('animationend', () => {
        sheet.remove();
        if (onDismiss) onDismiss();
      }, { once: true });
      // Fallback in case animationend doesn't fire
      setTimeout(() => {
        if (sheet.parentNode) {
          sheet.remove();
          if (onDismiss) onDismiss();
        }
      }, 350);
    } else {
      // Snap back
      content.style.transition = 'transform 0.2s ease';
      content.style.transform = 'translateY(0)';
      if (backdrop) {
        backdrop.style.transition = 'opacity 0.2s ease';
        backdrop.style.opacity = '';
      }
      setTimeout(() => {
        content.style.transition = '';
        content.style.transform = '';
      }, 200);
    }
    isDragging = false;
    isDragDismiss = false;
  };

  // Attach to content's touch events
  content.addEventListener('touchstart', onTouchStart, { passive: true });
  content.addEventListener('touchmove', onTouchMove, { passive: false });
  content.addEventListener('touchend', onTouchEnd, { passive: true });
}

function showSectionPicker(e) {
  e.stopPropagation();
  const picker = $('section-picker');
  if (!picker) return;

  const btns = picker.querySelectorAll('.section-picker-btn');
  const backdrop = picker.querySelector('.section-picker-backdrop');
  const content = picker.querySelector('.section-picker-content');

  // Close handler
  const close = () => {
    content.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
    content.style.transform = 'translateY(20px)';
    content.style.opacity = '0';
    backdrop.style.transition = 'opacity 0.2s ease';
    backdrop.style.opacity = '0';
    setTimeout(() => {
      picker.style.display = 'none';
      content.style.transition = '';
      content.style.transform = '';
      content.style.opacity = '';
      backdrop.style.transition = '';
      backdrop.style.opacity = '';
    }, 200);
  };

  // Button handlers
  btns.forEach(btn => {
    btn.onclick = () => {
      const type = btn.dataset.type;
      const song = getSong(currentSongId);
      if (!song) { close(); return; }
      pushVersion();
      song.sections.push({ type, strumming: null, lines: [{ text: '', chords: [] }] });
      saveSingleSong(song);
      renderEditorBody(song);
      const body = $('song-body');
      if (body) body.scrollTop = body.scrollHeight;
      close();
    };
  });

  // Backdrop dismiss
  backdrop.onclick = close;

  // Show
  picker.style.display = 'flex';
  // Trigger reflow for animation
  void content.offsetHeight;
  content.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
  content.style.transform = 'translateY(0)';
  content.style.opacity = '1';
  backdrop.style.transition = 'opacity 0.25s ease';
  backdrop.style.opacity = '1';

  // Enable drag to dismiss
  enableDragToDismiss(picker, { contentSelector: '.section-picker-content', backdropSelector: '.section-picker-backdrop' });
}

async function deleteSong(id) {
  const song = songs.find(s => s.id === id);
  if (song) {
    // Move to trash instead of permanent delete
    trash.unshift({ song, deletedAt: new Date().toISOString() });
    saveTrash();
  }
  songs = songs.filter(s => s.id !== id);
  flushLocalStorage();
  if (isTauri) await tauriDeleteSong(id);
}

// Restore a song from trash back to active songs
async function restoreSong(id) {
  const entry = trash.find(t => t.song.id === id);
  if (!entry) return;
  // If song id already exists in active songs, skip (avoid duplicates)
  if (!songs.find(s => s.id === entry.song.id)) {
    songs.unshift(entry.song);
  }
  trash = trash.filter(t => t.song.id !== id);
  saveTrash();
  flushLocalStorage();
  if (isTauri) await tauriSaveSong(entry.song);
}

// Permanently delete a song from trash
async function permanentlyDeleteSong(id) {
  trash = trash.filter(t => t.song.id !== id);
  saveTrash();
  deleteAutoBackupsForSong(id);
  if (isTauri) await tauriDeleteSong(id);
}

// Purge trash items older than 30 days
function purgeExpiredTrash() {
  const before = trash.length;
  trash = trash.filter(t => {
    const d = new Date(t.deletedAt || 0);
    return Date.now() - d.getTime() < 30 * 86400000;
  });
  if (trash.length !== before) saveTrash();
}

// Duplicate the current song (deep copy with new id and title suffix)
async function duplicateCurrentSong() {
  const song = getSong(currentSongId);
  if (!song) { toast('No song to duplicate'); return; }
  hideToolbarSheet();
  const copy = JSON.parse(JSON.stringify(song));
  copy.id = generateId();
  copy.title = (song.title || 'Untitled') + ' (Copy)';
  copy.created_at = new Date().toISOString();
  copy.updated_at = new Date().toISOString();
  copy.pinned = false;
  songs.unshift(copy);
  await saveSongs();
  renderSongList($('search-input')?.value || '');
  toast(`Duplicated "${song.title}"`);
}

// Clear all chords from the current song (with undo support via undoBuffer)
function clearAllChords() {
  const song = getSong(currentSongId);
  if (!song) { toast('No song open'); return; }
  // Deep-copy sections for undo
  const savedSections = JSON.parse(JSON.stringify(song.sections));
  let chordCount = 0;
  song.sections.forEach(sec => {
    sec.lines.forEach(line => { chordCount += (line.chords || []).length; line.chords = []; });
  });
  if (chordCount === 0) { toast('No chords to clear'); return; }
  pushVersion();
  saveSingleSong(song);
  renderEditorBody(song);
  undoBuffer = {
    type: 'clear-chords', songId: song.id,
    restore: () => {
      const s = getSong(song.id);
      if (!s) return;
      s.sections = JSON.parse(JSON.stringify(savedSections));
      s.updated_at = new Date().toISOString();
      saveSingleSong(s); renderEditorBody(s);
      toast('Chords restored', 'success');
    }
  };
  showUndoToast(`Cleared ${chordCount} chord${chordCount !== 1 ? 's' : ''}`);
}

// Version History
function pushVersion() {
  const song = getSong(currentSongId);
  if (!song) return;
  versionHistory.push({ ts: Date.now(), key: song.key, sections: JSON.parse(JSON.stringify(song.sections)) });
  if (versionHistory.length > 20) versionHistory.shift();
  updateUndoBtn();
}
function updateUndoBtn() {
  const btn = $('undo-btn');
  if (btn) btn.disabled = versionHistory.length === 0;
}
function undoVersion() {
  if (!versionHistory.length) { toast('No previous version'); return; }
  const prev = versionHistory.pop();
  const song = getSong(currentSongId);
  if (!song) return;
  song.key = prev.key; song.sections = prev.sections;
  saveSingleSong(song); openEditor(currentSongId); toast('Restored', 'success');
}
function toggleHistory() {
  const p = $('history-panel');
  p.style.display = p.style.display === 'none' ? 'flex' : 'none';
  if (p.style.display === 'flex') renderHistoryList();
}
function renderHistoryList() {
  const list = $('hist-list');
  const song = getSong(currentSongId);
  const autoBackups = song?.id ? (loadAutoBackups()[song.id] || []) : [];

  let html = '';

  // Auto-backups section
  if (autoBackups.length) {
    html += `<div class="hist-section-label">Auto-Backups</div>`;
    html += [...autoBackups].reverse().map((v, i) => {
      const idx = autoBackups.length - 1 - i;
      return `<div class="hist-item hist-backup" data-ab-idx="${idx}"><div class="hist-time">${new Date(v.ts).toLocaleTimeString()}</div><div class="hist-meta">${esc(v.key || '—')} · ${v.sections.reduce((a,s) => a + s.lines.length, 0)} lines <span class="hist-ab-tag">auto</span></div></div>`;
    }).join('');
  }

  // Manual version history section
  if (versionHistory.length) {
    html += `<div class="hist-section-label">Versions</div>`;
    html += [...versionHistory].reverse().map(v => `<div class="hist-item" data-ts="${v.ts}"><div class="hist-time">${new Date(v.ts).toLocaleTimeString()}</div><div class="hist-meta">${esc(v.key || '—')} · ${v.sections.reduce((a,s) => a + s.lines.length, 0)} lines</div></div>`).join('');
  }

  if (!html) {
    html = '<div style="padding:20px;text-align:center;color:var(--fg-tertiary);font-size:13px;">No versions yet</div>';
  }

  list.innerHTML = html;

  // Wire up version history items
  list.querySelectorAll('.hist-item:not(.hist-backup)').forEach(el => {
    el.addEventListener('click', () => {
      const v = versionHistory.find(x => x.ts === parseInt(el.dataset.ts));
      if (!v) return;
      showVersionDiff(v);
    });
  });

  // Wire up auto-backup items
  list.querySelectorAll('.hist-item.hist-backup').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.abIdx);
      const snap = autoBackups[idx];
      if (!snap) return;
      showAutoBackupDiff(snap);
    });
  });
}

// ===== Auto-Backup Diff View =====
function showAutoBackupDiff(snapshot) {
  const song = getSong(currentSongId);
  if (!song) return;

  const oldText = sectionsToText(snapshot.sections);
  const newText = sectionsToText(song.sections);
  const diff = computeDiff(oldText, newText);

  const modal = document.createElement('div');
  modal.id = 'diff-modal';
  modal.innerHTML = `
    <div class="diff-backdrop"></div>
    <div class="diff-content">
      <div class="diff-header">
        <div class="diff-title">Auto-Backup Diff</div>
        <div class="diff-subtitle">${new Date(snapshot.ts).toLocaleString()} → Now</div>
        <div class="diff-key-changes">${esc(snapshot.key || '—')} → ${esc(song.key || '—')}</div>
      </div>
      <div class="diff-body" id="diff-body">${diff}</div>
      <div class="diff-actions">
        <button id="diff-restore-btn" class="diff-btn diff-restore">Restore This Backup</button>
        <button id="diff-close-btn" class="diff-btn diff-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('.diff-backdrop').onclick = () => modal.remove();
  modal.querySelector('#diff-close-btn').onclick = () => modal.remove();
  modal.querySelector('#diff-restore-btn').onclick = () => {
    showConfirmSheet({
      title: 'Restore Auto-Backup',
      body: `Restore the auto-backup from ${new Date(snapshot.ts).toLocaleString()}? Current version will be lost.`,
      confirmText: 'Restore',
      confirmClass: 'neutral',
      onConfirm: () => {
        const song2 = getSong(currentSongId);
        if (!song2) return;
        song2.key = snapshot.key;
        song2.sections = JSON.parse(JSON.stringify(snapshot.sections));
        saveSingleSong(song2);
        openEditor(currentSongId);
        modal.remove();
        $('history-panel').style.display = 'none';
        toast('Auto-backup restored', 'success');
      }
    });
  };
}

// ===== Version Diff View =====
function showVersionDiff(version) {
  const song = getSong(currentSongId);
  if (!song) return;

  // Build text representations for diff
  const oldText = sectionsToText(version.sections);
  const newText = sectionsToText(song.sections);
  const diff = computeDiff(oldText, newText);

  const modal = document.createElement('div');
  modal.id = 'diff-modal';
  modal.innerHTML = `
    <div class="diff-backdrop"></div>
    <div class="diff-content">
      <div class="diff-header">
        <div class="diff-title">Version Diff</div>
        <div class="diff-subtitle">${new Date(version.ts).toLocaleString()} → Now</div>
        <div class="diff-key-changes">${esc(version.key || '—')} → ${esc(song.key || '—')}</div>
      </div>
      <div class="diff-body" id="diff-body">${diff}</div>
      <div class="diff-actions">
        <button id="diff-restore-btn" class="diff-btn diff-restore">Restore This Version</button>
        <button id="diff-close-btn" class="diff-btn diff-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('.diff-backdrop').onclick = () => modal.remove();
  modal.querySelector('#diff-close-btn').onclick = () => modal.remove();
  modal.querySelector('#diff-restore-btn').onclick = () => {
    showConfirmSheet({
      title: 'Restore Version',
      body: 'Restore this version? Current version will be lost.',
      confirmText: 'Restore',
      confirmClass: 'neutral',
      onConfirm: () => {
        const song2 = getSong(currentSongId);
        if (!song2) return;
        song2.key = version.key;
        song2.sections = JSON.parse(JSON.stringify(version.sections));
        saveSingleSong(song2);
        openEditor(currentSongId);
        modal.remove();
        $('history-panel').style.display = 'none';
        toast('Version restored');
      }
    });
  };
}

function sectionsToText(sections) {
  const lines = [];
  (sections || []).forEach(sec => {
    lines.push(`[${sec.type}]`);
    (sec.lines || []).forEach(l => {
      const chordStr = (l.chords || []).sort((a, b) => a.x - b.x).map(c => `[${c.name}]`).join('');
      lines.push(chordStr + (l.text || ''));
    });
    lines.push('');
  });
  return lines;
}

// Simple line-by-line diff algorithm
function computeDiff(oldLines, newLines) {
  // Flatten to line arrays
  const oldL = Array.isArray(oldLines) ? oldLines : oldLines.split('\n');
  const newL = Array.isArray(newLines) ? newLines : newLines.split('\n');

  // Use LCS-based diff
  const m = oldL.length, n = newL.length;
  // For performance, limit diff size
  if (m > 500 || n > 500) {
    return '<div class="diff-truncated">Song too large for diff view</div>';
  }

  // LCS table
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldL[i - 1] === newL[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldL[i - 1] === newL[j - 1]) {
      result.unshift({ type: 'same', text: oldL[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', text: newL[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'remove', text: oldL[i - 1] });
      i--;
    }
  }

  // Render diff HTML
  let html = '';
  result.forEach(line => {
    const escaped = esc(line.text);
    if (line.type === 'add') {
      html += `<div class="diff-line diff-add"><span class="diff-marker">+</span><span>${escaped}</span></div>`;
    } else if (line.type === 'remove') {
      html += `<div class="diff-line diff-remove"><span class="diff-marker">−</span><span>${escaped}</span></div>`;
    } else {
      html += `<div class="diff-line diff-same"><span class="diff-marker"> </span><span>${escaped}</span></div>`;
    }
  });

  // Summary
  const adds = result.filter(r => r.type === 'add').length;
  const removes = result.filter(r => r.type === 'remove').length;
  const summary = `<div class="diff-summary">${adds} addition${adds !== 1 ? 's' : ''}, ${removes} removal${removes !== 1 ? 's' : ''}</div>`;

  return summary + html;
}

// Audio
async function startRecording() {
  if (isRecording) return; // prevent double-start
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 1
      }
    });
    // Try supported formats in order of preference
    let mimeType = '';
    const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav'];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) {
        mimeType = c;
        break;
      }
    }
    const opts = mimeType ? { mimeType } : {};
    mediaRecorder = new MediaRecorder(recordingStream, opts);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data) };
    mediaRecorder.onstop = () => {
      const actualType = mediaRecorder.mimeType || 'audio/webm';
      const blob = new Blob(audioChunks, { type: actualType });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const dataUrl = reader.result;
        const song = getSong(currentSongId);
        if (!song) return;
        if (!song.audio) song.audio = [];
        song.audio.push({ data: dataUrl, ts: Date.now() });
        await saveSingleSong(song); updateRecordUI();
        toast(`Recording saved (${song.audio.length})`);
      };
      reader.readAsDataURL(blob);
      // Test playback immediately
      const testUrl = URL.createObjectURL(blob);
      const testPlayer = new Audio(testUrl);
      testPlayer.onerror = () => {};
      testPlayer.play().then(() => {
        setTimeout(() => { testPlayer.pause(); URL.revokeObjectURL(testUrl); }, 100);
      }).catch(() => {});
    };
    mediaRecorder.start(100); // collect data every 100ms
    isRecording = true;
    updateRecordUI();
  } catch (e) {
    console.error('Recording start failed:', e);
    toast('Microphone access denied', 'error');
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) { mediaRecorder.stop(); isRecording = false; updateRecordUI(); }
  // Release microphone tracks so the hardware indicator turns off
  if (recordingStream) { recordingStream.getTracks().forEach(t => t.stop()); recordingStream = null; }
}

function updateRecordUI() {
  const btn = $('record-btn');
  if (btn) { btn.textContent = isRecording ? '■' : '●'; btn.classList.toggle('recording', isRecording); }
  const recBtn = $('recordings-btn');
  const song = getSong(currentSongId);
  const hasRecordings = song?.audio?.length > 0;
  if (recBtn) recBtn.style.display = hasRecordings ? '' : 'none';
  if (recBtn) recBtn.textContent = hasRecordings ? `▸ ${song.audio.length}` : '▸';
}

function playRecording(dataUrl) {
  if (!dataUrl) return;
  // Stop any current playback
  try { if (!audioPlayer.paused) { audioPlayer.pause(); audioPlayer.currentTime = 0; } } catch(e) {}
  // Create a fresh audio element each time
  const player = new Audio();
  player.src = dataUrl;
  player.onerror = (e) => { console.error('Audio error:', e); toast('Audio error', 'error'); };
  player.play().then(() => {
    toast('Playing...');
  }).catch(e => {
    console.error('Playback failed:', e.name, e.message);
    toast('Playback failed: ' + e.name, 'error');
  });
  player.onended = () => {
    document.querySelectorAll('.rec-item.recording-playing').forEach(i => i.classList.remove('recording-playing'));
    if (currentPlayingSongId) {
      currentPlayingSongId = null;
      renderSongList($('search-input')?.value || '');
    }
  };
  audioPlayer = player;
}

function toggleRecordingsDropdown() {
  const dd = $('recordings-dropdown');
  if (dd.style.display !== 'none') { dd.style.display = 'none'; return; }
  const song = getSong(currentSongId);
  const recordings = song?.audio || [];
  if (!recordings.length) { toast('No recordings'); return; }
  const recList = $('rec-list');
  recList.innerHTML = [...recordings].reverse().map((rec, i) => {
    const idx = recordings.length - 1 - i;
    return `<div class="rec-item" data-idx="${idx}"><span>Recording ${idx + 1} · ${new Date(rec.ts).toLocaleTimeString()}</span><button class="rec-play-btn">▶</button></div>`;
  }).join('');
  recList.querySelectorAll('.rec-play-btn').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      const item = b.closest('.rec-item');
      const idx = parseInt(item.dataset.idx);
      if (recordings[idx]) {
        playRecording(recordings[idx].data);
      }
    });
  });
  recList.querySelectorAll('.rec-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const idx = parseInt(item.dataset.idx);
      if (recordings[idx]) {
        playRecording(recordings[idx].data);
      }
    });
  });
  $('delete-all-recordings').onclick = () => {
    showConfirmSheet({
      title: 'Delete Recordings',
      body: 'Delete all recordings for this song?',
      confirmText: 'Delete',
      onConfirm: () => {
        const s = getSong(currentSongId); if (s) { s.audio = []; saveSingleSong(s); }
        dd.style.display = 'none'; updateRecordUI();
      }
    });
  };
  dd.style.display = 'block';
}

// Render helpers
function esc(text) { return (text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Highlight search query matches in text (safe HTML: escapes text first, then wraps matches in <mark>)
function highlightMatch(text, query) {
  if (!text || !query) return esc(text || '');
  const escaped = esc(text);
  const q = esc(query);
  // Case-insensitive replace, preserving original case
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(re, '<mark class="search-highlight">$&</mark>');
}

function fmtDate(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'Now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return new Date(iso).toLocaleDateString();
}

function triggerAutoSave(song) {
  clearTimeout(autoSaveTimer);
  hasChanges = true;
  $('save-btn').disabled = false;
  updateSaveDot('unsaved');
  autoSaveTimer = setTimeout(async () => {
    if (!song) return;
    // Sync title from input before saving
    const titleEl = $('song-title');
    if (titleEl) song.title = titleEl.value || 'Untitled';
    song.updated_at = new Date().toISOString();
    // Push auto-backup snapshot before saving
    pushAutoBackup(song);
    await saveSingleSong(song);
    hasChanges = false;
    $('save-btn').disabled = true;
    updateSaveDot('saved');
  }, 1200);
}

// ===== Auto-Backup System =====
// Keeps last N auto-saved snapshots per song, separate from version history.
// Stored in localStorage as { [songId]: [{ ts, key, title, sections }], ... }

const AUTO_BACKUP_MAX = 10; // max snapshots per song

function loadAutoBackups() {
  try { return JSON.parse(localStorage.getItem('sn_auto_backups')) || {}; } catch { return {}; }
}

function saveAutoBackups(data) {
  safeStorageSet('sn_auto_backups', JSON.stringify(data));
}

function pushAutoBackup(song) {
  if (!song || !song.id) return;
  const all = loadAutoBackups();
  if (!all[song.id]) all[song.id] = [];
  all[song.id].push({
    ts: Date.now(),
    key: song.key || '',
    title: song.title || 'Untitled',
    sections: JSON.parse(JSON.stringify(song.sections || []))
  });
  // Trim to max
  while (all[song.id].length > AUTO_BACKUP_MAX) all[song.id].shift();
  saveAutoBackups(all);
}

function deleteAutoBackupsForSong(songId) {
  const all = loadAutoBackups();
  delete all[songId];
  saveAutoBackups(all);
}

function updateSaveDot(state) {
  const dot = $('auto-save-dot');
  if (!dot) return;
  dot.className = 'save-dot ' + state;

  // Update "last saved" timestamp text
  const statusEl = $('save-status-text');
  if (!statusEl) return;
  if (state === 'saved') {
    statusEl.textContent = 'Saved';
    statusEl.classList.add('visible');
    saveStatusLastShown = Date.now();
    // Start the "Xm ago" updater if not already running
    if (!saveStatusInterval) {
      saveStatusInterval = setInterval(updateSaveStatusAgo, 15000);
    }
    // Auto-hide after 6s
    if (saveStatusHideTimer) clearTimeout(saveStatusHideTimer);
    saveStatusHideTimer = setTimeout(() => {
      statusEl.classList.remove('visible');
    }, 6000);
  } else if (state === 'unsaved') {
    statusEl.textContent = 'Editing…';
    statusEl.classList.add('visible');
    if (saveStatusHideTimer) clearTimeout(saveStatusHideTimer);
  } else if (state === 'saving') {
    statusEl.textContent = 'Saving…';
    statusEl.classList.add('visible');
    if (saveStatusHideTimer) clearTimeout(saveStatusHideTimer);
  }
}

// Tracks when the "Saved" label was first shown, for "Xm ago" display.
let saveStatusLastShown = 0;
let saveStatusInterval = null;
let saveStatusHideTimer = null;

function updateSaveStatusAgo() {
  const el = $('save-status-text');
  if (!el || !saveStatusLastShown || !el.classList.contains('visible')) return;
  const elapsed = Date.now() - saveStatusLastShown;
  const min = Math.floor(elapsed / 60000);
  if (min < 1) {
    el.textContent = 'Saved just now';
  } else if (min < 60) {
    el.textContent = 'Saved ' + min + 'm ago';
  } else {
    const h = Math.floor(min / 60);
    el.textContent = 'Saved ' + min + 'm ago';
  }
}

function clearSaveStatusTimers() {
  if (saveStatusInterval) { clearInterval(saveStatusInterval); saveStatusInterval = null; }
  if (saveStatusHideTimer) { clearTimeout(saveStatusHideTimer); saveStatusHideTimer = null; }
  saveStatusLastShown = 0;
  const el = $('save-status-text');
  if (el) el.classList.remove('visible');
}

// ===== Offline Indicator & Sync Queue =====

function updateOfflineIndicator() {
  const el = $('offline-indicator');
  if (!el) return;
  if (isOnline) {
    el.classList.remove('visible');
    el.setAttribute('aria-hidden', 'true');
    const qCount = $('offline-queue-count');
    if (qCount) qCount.textContent = '';
  } else {
    el.classList.add('visible');
    el.setAttribute('aria-hidden', 'false');
    updateQueueCount();
  }
}

function updateQueueCount() {
  const el = $('offline-queue-count');
  if (!el) return;
  const pending = syncQueue.length;
  el.textContent = pending > 0 ? `${pending} saved offline` : '';
}

// Wrap saveSingleSong to queue when offline
async function queueOrSave(song) {
  if (!song) return;
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song; else songs.unshift(song);
  queueLocalStorageSave();

  if (isOnline) {
    // Online: save to Tauri immediately if available
    if (isTauri) {
      try {
        await tauriSaveSong(song);
      } catch (e) {
        console.warn('Tauri save failed, queuing:', e);
        enqueueSync('save', song);
      }
    }
  } else {
    // Offline: queue Tauri sync for later
    if (isTauri) {
      enqueueSync('save', song);
    }
    // Update save dot to show "saved locally" state
    updateSaveDot('unsaved');
  }
}

function enqueueSync(operation, song) {
  // Deduplicate: replace existing queue entry for same song+operation
  const existingIdx = syncQueue.findIndex(q => q.songId === song.id && q.operation === operation);
  if (existingIdx >= 0) {
    syncQueue[existingIdx] = { operation, song, ts: Date.now(), songId: song.id };
  } else {
    syncQueue.push({ operation, song, ts: Date.now(), songId: song.id });
  }
  // Persist queue to localStorage for survival across page reloads
  try {
    safeStorageSet('sn_sync_queue', JSON.stringify(syncQueue.map(q => ({ operation: q.operation, songId: q.songId }))));
  } catch {}
  updateQueueCount();
}

function flushSyncQueue() {
  if (!isOnline || !isTauri || syncQueue.length === 0) return;
  const queue = [...syncQueue];
  syncQueue = [];
  updateQueueCount();
  // Flush in background
  (async () => {
    let success = 0;
    let failed = 0;
    for (const item of queue) {
      try {
        if (item.operation === 'save') {
          // Re-merge latest song data in case it was updated while queued
          const latest = songs.find(s => s.id === item.song.id);
          await tauriSaveSong(latest || item.song);
        }
        success++;
      } catch (e) {
        console.warn('Sync flush failed for', item.songId, e);
        failed++;
      }
    }
    if (success > 0) {
      toast(`Synced ${success} song${success !== 1 ? 's' : ''} from offline`, 'success');
    }
    if (failed > 0) {
      toast(`Sync failed for ${failed} item${failed !== 1 ? 's' : ''}`, 'error');
    }
  })();
}

// Load persisted queue metadata on init
function loadSyncQueueMeta() {
  try {
    const raw = localStorage.getItem('sn_sync_queue');
    if (raw) {
      const meta = JSON.parse(raw);
      if (Array.isArray(meta) && meta.length > 0) {
        // Rebuild queue from current song data
        meta.forEach(m => {
          const song = songs.find(s => s.id === m.songId);
          if (song) syncQueue.push({ operation: m.operation, song, ts: Date.now(), songId: m.songId });
        });
        if (syncQueue.length > 0) {
          localStorage.removeItem('sn_sync_queue');
          updateQueueCount();
        }
      }
    }
  } catch {}
}

function handleOnline() {
  isOnline = true;
  updateOfflineIndicator();
  toast('Back online', 'success');
  // Flush any queued syncs
  if (isTauri && syncQueue.length > 0) {
    const count = syncQueue.length;
    toast(`Syncing ${count} offline change${count !== 1 ? 's' : ''}…`);
    flushSyncQueue();
  }
}

function handleOffline() {
  isOnline = false;
  updateOfflineIndicator();
  toast('You are offline — changes saved locally', 'info');
}

// ===== Session Timer =====
function formatSessionTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function startSessionTimer() {
  stopSessionTimer();
  const song = getSong(currentSongId);
  sessionTotalMs = song?.session_ms || 0;
  sessionStartTime = Date.now();
  updateSessionTimerDisplay();
  sessionTimerInterval = setInterval(updateSessionTimerDisplay, 1000);
}

function stopSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
  // Persist accumulated time to song
  if (sessionStartTime && currentSongId) {
    const song = getSong(currentSongId);
    if (song) {
      sessionTotalMs += Date.now() - sessionStartTime;
      song.session_ms = sessionTotalMs;
      saveSingleSong(song);
    }
  }
  sessionStartTime = null;
  const el = $('session-timer');
  if (el) el.textContent = '';
}

function updateSessionTimerDisplay() {
  const el = $('session-timer');
  if (!el || !sessionStartTime) return;
  const elapsed = sessionTotalMs + (Date.now() - sessionStartTime);
  el.textContent = formatSessionTime(elapsed);
}

// ===== Focus Mode =====
function toggleFocusMode() {
  focusMode = !focusMode;
  safeStorageSet('sn_focusMode', focusMode ? 'true' : 'false');
  applyFocusMode();
}

function applyFocusMode() {
  const editor = $('editor-view');
  if (!editor) return;
  editor.classList.toggle('focus-mode', focusMode);
  const focusBtn = $('focus-btn');
  if (focusBtn) {
    focusBtn.classList.toggle('active', focusMode);
    focusBtn.title = focusMode ? 'Exit focus' : 'Focus mode';
  }
  // Hide/show toolbar and chord ribbon
  const toolbar = $('mobile-toolbar');
  const fab = $('toolbar-fab');
  const ribbon = $('chord-ribbon');
  if (toolbar) toolbar.style.display = focusMode ? 'none' : '';
  if (fab) fab.style.display = focusMode ? 'none' : '';
  if (ribbon) ribbon.style.display = focusMode ? 'none' : '';
}

// Folders
function getFolderCount(f) {
  if (f === 'All Songs') return songs.length;
  if (f === 'Recently Edited') return songs.filter(s => {
    const d = new Date(s.updated_at || s.created_at || 0);
    return Date.now() - d.getTime() < 7 * 86400000;
  }).length;
  if (f === 'Recently Deleted') return trash.length;
  return songs.filter(s => s.folder === f).length;
}

function renderFolders() {
  const el = $('folder-list');
  // Smart folders always at top
  const smartFolders = ['All Songs', 'Recently Edited', 'Recently Deleted'];
  const customFolders = folders.filter(f => !smartFolders.includes(f));

  el.innerHTML = [...smartFolders, ...customFolders].map(f => {
    const count = getFolderCount(f);
    const cls = f === currentFolder ? 'list-item active' : 'list-item';
    const icon = f === 'All Songs' ? '♫' : f === 'Recently Edited' ? '↻' : f === 'Recently Deleted' ? '✕' : '♪';
    return `<div class="${cls}" data-folder="${esc(f)}" role="option" aria-selected="${f === currentFolder ? 'true' : 'false'}"><span class="item-icon">${icon}</span><span class="item-title">${esc(f === 'Recently Edited' ? 'Recently Edited' : f)}</span><span class="item-meta">${count}</span>${!smartFolders.includes(f) ? '<span class="folder-dots">⋯</span>' : ''}</div>`;
  }).join('');
  el.querySelectorAll('.list-item[data-folder]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.folder-dots')) return;
      currentFolder = item.dataset.folder;
      const cnt = getFolderCount(currentFolder);
      $('folder-title').textContent = currentFolder + ' · ' + cnt;
      renderSongList(); pushView('song-list-view');
      // Show gallery view hint on first visit to song list
      if (!featureHints['gallery-view']) {
        markHintShown('gallery-view');
        setTimeout(() => {
          const btn = $('view-toggle');
          if (btn) showFeatureHint(btn, 'Tap to toggle gallery view', 'bottom');
        }, 600);
      }
    });
    const dots = item.querySelector('.folder-dots');
    if (dots) dots.addEventListener('click', e => { e.stopPropagation(); showFolderActions(item.dataset.folder, dots); });
  });
  // Keep folder title count in sync
  const _cnt = getFolderCount(currentFolder);
  const _ft = $('folder-title');
  if (_ft) _ft.textContent = currentFolder + ' · ' + _cnt;
}

let activeFolderName = '';
let activeSortMode = 'recent'; // recent | title-za | title-az | key

// ===== Undo Buffer =====
let undoBuffer = null;
let undoTimer = null;

function showUndoToast(msg, onUndo) {
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast toast-undo';
  el.textContent = msg;
  const undoBtn = document.createElement('button');
  undoBtn.className = 'toast-undo-btn';
  undoBtn.textContent = 'Undo';
  el.appendChild(undoBtn);
  document.body.appendChild(el);
  const duration = 4000;

  const dismiss = () => {
    undoTimer = null;
    el.classList.add('toast-exit');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  };
  undoBtn.addEventListener('click', () => {
    if (undoBuffer) {
      try { undoBuffer.restore(); } catch(e) { console.error('Undo failed:', e); }
      undoBuffer = null;
    }
    dismiss();
  });
  undoBtn.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); });
  undoTimer = setTimeout(() => { undoBuffer = null; dismiss(); }, duration);
}
function clearUndo() {
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  undoBuffer = null;
}

// ===== Sort Popover =====
function showSortPopover(anchorEl) {
  // Close existing
  hideSortPopover();
  const popover = document.createElement('div');
  popover.id = 'sort-popover';
  popover.className = 'popover sort-popover';
  const modes = [
    { id: 'recent', label: 'Recent', icon: '↻' },
    { id: 'title-az', label: 'A → Z', icon: 'A' },
    { id: 'title-za', label: 'Z → A', icon: 'Z' },
    { id: 'key', label: 'Key', icon: '♫' },
    { id: 'bpm', label: 'BPM', icon: '⌖' },
  ];
  popover.innerHTML = modes.map(m =>
    `<button class="sort-opt${activeSortMode === m.id ? ' active' : ''}" data-mode="${m.id}"><span class="sort-opt-icon">${m.icon}</span>${m.label}</button>`
  ).join('');
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.top = (rect.bottom + 4) + 'px';
  popover.style.right = (window.innerWidth - rect.right) + 'px';
  popover.style.display = 'block';
  popover.querySelectorAll('.sort-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.mode;
      if (newMode === activeSortMode) { hideSortPopover(); return; }
      activeSortMode = newMode;
      safeStorageSet('sn_app_sort', activeSortMode);
      hideSortPopover();
      updateSortBtn();
      renderSongList($('search-input')?.value || '');
    });
  });
  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', hideSortPopover, { once: true });
  }, 50);
}
function hideSortPopover() {
  const p = $('sort-popover');
  if (p) p.remove();
}
function updateSortBtn() {
  const btn = $('sort-btn');
  if (!btn) return;
  btn.classList.toggle('nav-btn-active', activeSortMode !== 'recent');
  const SORT_LABELS = { 'title-az': 'A-Z', 'title-za': 'Z-A', 'key': 'Key', 'bpm': 'BPM' };
  const label = SORT_LABELS[activeSortMode] || '';
  btn.textContent = label ? `↕ ${label}` : '↕';
}

function showFolderActions(name, anchor) {
  activeFolderName = name;
  const menu = $('folder-actions');
  const rect = anchor.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = '16px';
  menu.style.display = 'block';
}

function setupFolderActions() {
  $('folder-actions').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      $('folder-actions').style.display = 'none';
      if (btn.dataset.action === 'rename') {
        showInputSheet({
          title: 'Rename Folder',
          placeholder: 'Folder name',
          initialValue: activeFolderName,
          onConfirm: (name) => {
            if (name && name !== activeFolderName) {
              const idx = folders.indexOf(activeFolderName);
              if (idx >= 0) { folders[idx] = name; songs.forEach(s => { if (s.folder === activeFolderName) s.folder = name; }); }
              saveSongs(); persistFolders(); renderFolders();
            }
          }
        });
      } else if (btn.dataset.action === 'delete-folder') {
        showConfirmSheet({
          title: 'Delete Folder',
          body: `Delete "${activeFolderName}"? Songs move to All Songs.`,
          confirmText: 'Delete',
          onConfirm: () => {
            songs.forEach(s => { if (s.folder === activeFolderName) s.folder = null; });
            folders = folders.filter(f => f !== activeFolderName);
            saveSongs(); persistFolders(); renderFolders();
          }
        });
      }
    });
  });
}

async function persistFolders() {
  safeStorageSet('folders_app', JSON.stringify(folders));
  if (isTauri) await tauriSaveFolders(folders);
}

// Song context menu (long press)
let contextSongId = null;
let activeTagFilter = null;
function showSongContext(songId, anchorEl) {
  contextSongId = songId;
  const song = getSong(songId);
  if (!song) return;
  // Close any existing context menus
  document.querySelectorAll('.popover').forEach(m => m.style.display = 'none');
  
  // Build or reuse context menu
  let menu = $('song-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'song-context-menu';
    menu.className = 'popover';
    menu.innerHTML = `
      <button data-action="pin">★ Pin</button>
      <button data-action="duplicate">⧉ Duplicate</button>
      <button data-action="share">↗ Share</button>
      <button data-action="edit-tags"># Tags</button>
      <button data-action="move-folder">◎ Move to Folder</button>
      <button data-action="export-txt">Export Text</button>
      <button data-action="export-md">Export MD</button>
      <button data-action="delete" class="danger">Delete</button>
    `;
    document.body.appendChild(menu);
    
    menu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        menu.style.display = 'none';
        const s = getSong(contextSongId);
        if (!s) return;
        
        if (btn.dataset.action === 'pin') {
          s.pinned = !s.pinned;
          await saveSingleSong(s);
          renderSongList($('search-input').value);
          toast(s.pinned ? 'Pinned ★' : 'Unpinned');
        } else if (btn.dataset.action === 'duplicate') {
          const copy = JSON.parse(JSON.stringify(s));
          copy.id = generateId();
          copy.title = s.title + ' (copy)';
          copy.pinned = false;
          copy.created_at = new Date().toISOString();
          copy.updated_at = new Date().toISOString();
          songs.unshift(copy);
          await saveSongs();
          renderSongList($('search-input').value);
          toast('Duplicated');
        } else if (btn.dataset.action === 'share') {
          currentSongId = contextSongId;
          showShareSheet();
        } else if (btn.dataset.action === 'edit-tags') {
          currentSongId = contextSongId;
          showTagEditorPanel();
        } else if (btn.dataset.action === 'move-folder') {
          showMoveToFolderSheet(s);
        } else if (btn.dataset.action === 'export-txt') {
          downloadFile(buildExportText(s), `${s.title}.txt`, 'text/plain');
        } else if (btn.dataset.action === 'export-md') {
          downloadFile(buildExportMarkdown(s), `${s.title}.md`, 'text/markdown');
        } else if (btn.dataset.action === 'delete') {
          showConfirmSheet({
            title: 'Delete Song',
            body: `Delete "${s.title}"?`,
            confirmText: 'Delete',
            onConfirm: async () => {
              await deleteSong(contextSongId);
              if (currentSongId === contextSongId) { currentSongId = null; }
              renderSongList($('search-input').value);
              toast('Deleted');
            }
          });
        }
      });
    });
  }
  
  // Update pin button text
  const pinBtn = menu.querySelector('[data-action="pin"]');
  if (pinBtn) pinBtn.textContent = song.pinned ? '☆ Unpin' : '★ Pin';
  
  // Position menu
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = Math.min(rect.top, window.innerHeight - 200) + 'px';
  menu.style.left = 'auto';
  menu.style.right = '16px';
  menu.style.display = 'block';
}

// ===== Move to Folder Sheet =====
function showMoveToFolderSheet(song) {
  const sheet = document.createElement('div');
  sheet.className = 'confirm-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Move to folder');

  const customFolders = folders.filter(f => f !== 'All Songs' && f !== 'Recently Edited');
  const currentFolderName = song.folder || null;

  let folderListHtml = '';
  // "No folder" / All Songs option
  const isAllSongs = !currentFolderName;
  folderListHtml += `<button class="folder-picker-item${isAllSongs ? ' selected' : ''}" data-folder="">
    <span class="folder-picker-icon">♫</span>
    <span class="folder-picker-name">All Songs</span>
    ${isAllSongs ? '<span class="folder-picker-check">✓</span>' : ''}
  </button>`;

  // Custom folders
  customFolders.forEach(f => {
    const isCurrent = currentFolderName === f;
    folderListHtml += `<button class="folder-picker-item${isCurrent ? ' selected' : ''}" data-folder="${escHtml(f)}">
      <span class="folder-picker-icon">♪</span>
      <span class="folder-picker-name">${escHtml(f)}</span>
      ${isCurrent ? '<span class="folder-picker-check">✓</span>' : ''}
    </button>`;
  });

  if (!customFolders.length) {
    folderListHtml += `<div class="folder-picker-empty">No custom folders yet</div>`;
  }

  sheet.innerHTML = `
    <div class="confirm-sheet-backdrop"></div>
    <div class="confirm-sheet-content" style="max-height:60vh;">
      <div class="confirm-sheet-handle"></div>
      <div class="confirm-sheet-title">Move to Folder</div>
      <div class="folder-picker-list">
        ${folderListHtml}
      </div>
      <div class="confirm-sheet-actions">
        <button class="confirm-sheet-cancel">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(sheet);

  const close = () => sheet.remove();
  sheet.querySelector('.confirm-sheet-backdrop').onclick = close;
  sheet.querySelector('.confirm-sheet-cancel').onclick = close;

  enableDragToDismiss(sheet, {
    contentSelector: '.confirm-sheet-content',
    backdropSelector: '.confirm-sheet-backdrop',
    onDismiss: close
  });

  sheet.querySelectorAll('.folder-picker-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetFolder = btn.dataset.folder || null;
      if (targetFolder !== currentFolderName) {
        song.folder = targetFolder;
        song.updated_at = new Date().toISOString();
        await saveSingleSong(song);
        renderSongList($('search-input')?.value || '');
        toast(targetFolder ? `Moved to ${targetFolder}` : 'Moved to All Songs');
      }
      close();
    });
  });
}

// Skeleton loading for song list
function showSongListSkeleton(count = 6) {
  const el = $('song-list');
  if (!el) return;
  let html = '<div class="skeleton-section-header"><div class="skeleton-section-label"></div></div>';
  // Vary the widths slightly for realism
  const titleWidths = [70, 55, 80, 45, 65, 50];
  const metaWidths = [50, 60, 40, 55, 45, 65];
  for (let i = 0; i < count; i++) {
    const tw = titleWidths[i % titleWidths.length];
    const mw = metaWidths[i % metaWidths.length];
    const hasPin = i % 3 === 0;
    const hasKey = i % 2 === 1;
    html += '<div class="skeleton-item">';
    if (hasPin) html += '<div class="skeleton-line skeleton-pin"></div>';
    html += `<div class="skeleton-line skeleton-title" style="width:${tw}%"></div>`;
    if (hasKey) html += '<div class="skeleton-line skeleton-key"></div>';
    html += `<div class="skeleton-line skeleton-meta" style="width:${mw}px"></div>`;
    html += '</div>';
  }
  el.innerHTML = html;
}
// Stagger the shimmer so items don't pulse in perfect lockstep
function showSongListSkeletonStaggered(count = 6) {
  const el = $('song-list');
  if (!el) return;
  let html = '<div class="skeleton-section-header"><div class="skeleton-section-label"></div></div>';
  const titleWidths = [70, 55, 80, 45, 65, 50];
  const metaWidths = [50, 60, 40, 55, 45, 65];
  for (let i = 0; i < count; i++) {
    const tw = titleWidths[i % titleWidths.length];
    const mw = metaWidths[i % metaWidths.length];
    const hasPin = i % 3 === 0;
    const hasKey = i % 2 === 1;
    const delay = i * 0.1;
    html += '<div class="skeleton-item">';
    if (hasPin) html += `<div class="skeleton-line skeleton-pin" style="animation-delay:${delay}s"></div>`;
    html += `<div class="skeleton-line skeleton-title" style="width:${tw}%;animation-delay:${delay}s"></div>`;
    if (hasKey) html += `<div class="skeleton-line skeleton-key" style="animation-delay:${delay}s"></div>`;
    html += `<div class="skeleton-line skeleton-meta" style="width:${mw}px;animation-delay:${delay}s"></div>`;
    html += '</div>';
  }
  el.innerHTML = html;
}

// Trash list — shows deleted songs with restore + permanent delete
function renderTrashList(el, filter = '') {
  // Header nav title
  $('song-title').textContent = 'Recently Deleted';

  // Remove any existing trash actions bar
  const existingBar = $('trash-actions-bar');
  if (existingBar) existingBar.remove();

  if (!trash.length) {
    el.innerHTML = `<div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M24 28h32M30 28v-4a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6v4M34 36v20M40 36v20M46 36v20" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="20" y="28" width="40" height="32" rx="4" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
          </svg>
        </div>
        <h2>Trash is Empty</h2>
        <p>Deleted songs appear here for 30 days</p>
      </div>`;
      return;
    }

    // Trash actions bar — Restore All + Empty Trash
    const bar = document.createElement('div');
    bar.id = 'trash-actions-bar';
    bar.className = 'trash-actions-bar';
    bar.innerHTML = `
      <button class="trash-action-btn" id="trash-restore-all" aria-label="Restore all songs">
        <span class="trash-action-icon">↩</span>
        <span class="trash-action-label">Restore All</span>
      </button>
      <button class="trash-action-btn trash-action-danger" id="trash-empty" aria-label="Empty trash permanently">
        <span class="trash-action-icon">✕</span>
        <span class="trash-action-label">Empty Trash</span>
      </button>
    `;
    el.parentNode.insertBefore(bar, el);

  let list = trash;
  if (filter) {
    const q = filter.toLowerCase();
    list = list.filter(t => t.song.title?.toLowerCase().includes(q));
  }

  // Sort by deletion date, newest first
  const sorted = [...list].sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));

  const DAYS = 30;
  const now = Date.now();

  let html = '';
  sorted.forEach((t, i) => {
    const s = t.song;
    const deletedMs = now - new Date(t.deletedAt || 0).getTime();
    const daysLeft = Math.max(0, Math.ceil((DAYS * 86400000 - deletedMs) / 86400000));
    const keyBadge = s.key ? `<span class="item-key">${esc(s.key)}</span>` : '';
    const agoLabel = formatTimeAgo(deletedMs);
    html += `<div class="list-item trash-item" data-trash-id="${esc(s.id)}" style="animation-delay:${i * 30}ms">
      <div class="trash-item-info">
        <span class="item-title">${highlightMatch(s.title || 'Untitled', filter)}${keyBadge}</span>
        <span class="item-meta">Deleted ${agoLabel} · ${daysLeft}d left</span>
      </div>
      <div class="trash-item-actions">
        <button class="trash-restore-btn" data-id="${esc(s.id)}" aria-label="Restore song">↩</button>
        <button class="trash-delete-btn" data-id="${esc(s.id)}" aria-label="Delete permanently">✕</button>
      </div>
    </div>`;
  });
  el.innerHTML = html;
  el.querySelectorAll('.trash-restore-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      showConfirmSheet({
        title: 'Restore Song',
        body: 'Restore this song to your library?',
        confirmText: 'Restore',
        onConfirm: async () => {
          await restoreSong(id);
          renderTrashList(el, filter);
          renderFolders(); // update count badge
          toast('Song restored');
        }
      });
    });
  });
  el.querySelectorAll('.trash-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      showConfirmSheet({
        title: 'Delete Forever',
        body: 'This cannot be undone.',
        confirmText: 'Delete',
        confirmClass: 'sheet-danger',
        onConfirm: async () => {
          await permanentlyDeleteSong(id);
          renderTrashList(el, filter);
          renderFolders();
          toast('Deleted permanently');
        }
      });
    });
  });

  // Trash actions bar event listeners
  const restoreAllBtn = $('trash-restore-all');
  if (restoreAllBtn) {
    restoreAllBtn.addEventListener('click', () => {
      showConfirmSheet({
        title: 'Restore All Songs',
        body: `Restore all ${trash.length} song${trash.length !== 1 ? 's' : ''} to your library?`,
        confirmText: 'Restore All',
        onConfirm: async () => {
          const ids = trash.map(t => t.song.id);
          for (const id of ids) await restoreSong(id);
          renderTrashList(el, filter);
          renderFolders();
          toast(`Restored ${ids.length} song${ids.length !== 1 ? 's' : ''}`);
        }
      });
    });
  }

  const emptyTrashBtn = $('trash-empty');
  if (emptyTrashBtn) {
    emptyTrashBtn.addEventListener('click', () => {
      showConfirmSheet({
        title: 'Empty Trash',
        body: `Permanently delete all ${trash.length} song${trash.length !== 1 ? 's' : ''}? This cannot be undone.`,
        confirmText: 'Empty Trash',
        confirmClass: 'sheet-danger',
        onConfirm: async () => {
          const count = trash.length;
          for (const t of [...trash]) await permanentlyDeleteSong(t.song.id);
          renderTrashList(el, filter);
          renderFolders();
          toast(`Deleted ${count} song${count !== 1 ? 's' : ''} permanently`);
        }
      });
    });
  }
}

function formatTimeAgo(ms) {
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

// ===== Virtual Scroll Helpers =====

// Build the virtual items array from the sorted song list (list mode only).
// Each entry: { type: 'header', name: 'Today', offset, height }
//             { type: 'song', song: s, offset, height }
function buildVirtualItems(sorted) {
  virtualItems = [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const thisWeek = new Date(today.getTime() - 6 * 86400000);
  let offset = 0;
  let lastSection = '';

  for (const s of sorted) {
    const d = new Date(s.updated_at || s.created_at || 0);
    let section = '';
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (dd.getTime() === today.getTime()) section = 'Today';
    else if (dd.getTime() === yesterday.getTime()) section = 'Yesterday';
    else if (dd >= thisWeek) section = 'This Week';
    else if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) section = 'This Month';
    else section = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    if (section !== lastSection) {
      virtualItems.push({ type: 'header', name: section, offset, height: HEADER_HEIGHT });
      offset += HEADER_HEIGHT;
      lastSection = section;
    }

    // Determine if this song has a preview line (affects height)
    const firstLine = s.sections?.[0]?.lines?.[0];
    const hasPreview = firstLine && (firstLine.text?.trim() || (firstLine.chords && firstLine.chords.length));
    const h = hasPreview ? ITEM_HEIGHT + 20 : ITEM_HEIGHT;

    virtualItems.push({ type: 'song', song: s, offset, height: h });
    offset += h;
  }

  return offset; // total height
}

// Render only the visible virtual items into the container
function renderVirtualItems(filter = '') {
  const el = $('song-list');
  if (!el || !virtualItems.length) return;

  const containerEl = el.closest('.list') || el.parentElement;
  if (!containerEl) return;

  const scrollTop = containerEl.scrollTop;
  const viewportH = containerEl.clientHeight;

  // Find visible range
  let startIdx = 0;
  let endIdx = virtualItems.length - 1;

  // Binary search for start
  let lo = 0, hi = virtualItems.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = virtualItems[mid];
    if (item.offset + item.height < scrollTop - VIRTUAL_BUFFER * ITEM_HEIGHT) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  startIdx = Math.max(0, lo - VIRTUAL_BUFFER);

  // Binary search for end
  lo = 0; hi = virtualItems.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = virtualItems[mid];
    if (item.offset > scrollTop + viewportH + VIRTUAL_BUFFER * ITEM_HEIGHT) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  endIdx = Math.min(virtualItems.length - 1, lo + VIRTUAL_BUFFER);

  // Build HTML for visible items
  let html = '';
  for (let i = startIdx; i <= endIdx; i++) {
    const item = virtualItems[i];
    if (item.type === 'header') {
      html += `<div class="list-section-header" style="position:absolute;top:${item.offset}px;left:0;right:0;height:${item.height}px">${esc(item.name)}</div>`;
    } else {
      html += buildSongRowHTML(item.song, item.offset, item.height, filter);
    }
  }

  // Set container to relative positioning for absolute children
  el.style.position = 'relative';
  el.innerHTML = html;
}

// Build HTML for a single song row (extracted from renderSongList)
function buildSongRowHTML(s, offset, height, filter = '') {
  const pinned = s.pinned ? '<span class="item-pin">★</span>' : '';
  const tagHtml = (s.tags && s.tags.length) ? `<span class="item-tags">${s.tags.map(t => `<span class="item-tag">${highlightMatch(t, filter)}</span>`).join('')}</span>` : '';
  const pinLabel = s.pinned ? '☆' : '★';

  let previewHtml = '';
  const firstLine = s.sections?.[0]?.lines?.[0];
  if (firstLine) {
    const lyricSnippet = firstLine.text?.trim()
      ? highlightMatch(firstLine.text.trim().slice(0, 40), filter)
      : '';
    const chords = (firstLine.chords || []).slice(0, 4);
    const chordHtml = chords.length
      ? `<span class="item-preview-chords">${chords.map(c => `<span class="item-preview-chord">${esc(c.name)}</span>`).join('')}</span>`
      : '';
    if (lyricSnippet || chordHtml) {
      previewHtml = `<span class="item-preview">${chordHtml}${lyricSnippet ? `<span class="item-preview-text">${lyricSnippet}${firstLine.text.trim().length > 40 ? '…' : ''}</span>` : ''}</span>`;
    }
  }

  const bpmBadge = s.bpm ? `<span class="item-bpm">${esc(String(s.bpm))}</span>` : '';
  const hasRec = s.audio && s.audio.length > 0;
  const isThisPlaying = currentPlayingSongId === s.id;
  const recBadge = hasRec ? `<button class="song-play-rec-btn${isThisPlaying ? ' playing' : ''}" data-id="${s.id}" aria-label="${isThisPlaying ? 'Pause' : 'Play'} recording" title="${isThisPlaying ? 'Pause' : 'Play'} latest recording (${s.audio.length})"><span class="rec-icon">${isThisPlaying ? '❚❚' : '▶'}</span><span class="rec-count">${s.audio.length}</span></button>` : '';
  const tutorialBadge = s.tutorial ? '<span class="tutorial-badge">Tutorial</span>' : '';

  // Writing time (compact format for list row)
  const wtMs = s.session_ms || 0;
  const wtH = Math.floor(wtMs / 3600000);
  const wtM = Math.floor((wtMs % 3600000) / 60000);
  const writingTimeHtml = wtMs > 0
    ? `<span class="item-writing-time" title="Writing time">${wtH > 0 ? wtH + 'h ' + wtM + 'm' : wtM + 'm'}</span>`
    : '';

  return `<div class="swipe-item${multiSelectMode && selectedSongIds.has(s.id) ? ' selected' : ''}" data-id="${s.id}" role="option" aria-selected="${multiSelectMode && selectedSongIds.has(s.id) ? 'true' : 'false'}" style="position:absolute;top:${offset}px;left:0;right:0;height:${height}px">
      <div class="swipe-bg">
        <button class="swipe-pin-btn" data-action="pin" aria-label="${s.pinned ? 'Unpin' : 'Pin'} song">${pinLabel}</button>
        <button class="swipe-duplicate-btn" data-action="duplicate" aria-label="Duplicate song">⧉</button>
        <button class="swipe-delete-btn" data-action="delete" aria-label="Delete song">✕</button>
      </div>
      <div class="swipe-content list-item">
        <div class="list-item-main">
          ${pinned}
          <span class="item-title">${highlightMatch(s.title || 'Untitled', filter)}${s.key ? `<span class="item-key">${esc(s.key)}</span>` : ''}${bpmBadge}${tutorialBadge}</span>
          ${tagHtml}
          <span class="item-meta">${fmtDate(s.updated_at)}</span>
          ${writingTimeHtml}
          ${recBadge}
        </div>
        ${previewHtml}
      </div>
    </div>`;
}

// Set up the virtual scroll container (called once)
function initVirtualScroll() {
  if (virtualScrollInitialized) return;
  virtualScrollInitialized = true;

  const el = $('song-list');
  if (!el) return;
  // #song-list itself has .list class and is the scrollable container
  const containerEl = el.classList.contains('list') ? el : el.closest('.list');
  if (!containerEl) return;

  containerEl.addEventListener('scroll', () => {
    if (virtualScrollRAF) cancelAnimationFrame(virtualScrollRAF);
    virtualScrollRAF = requestAnimationFrame(() => {
      if (!galleryMode && virtualItems.length) {
        renderVirtualItems(currentSearchFilter);
      }
    });
  }, { passive: true });
}

// Song list
function renderSongList(filter = '') {
  const el = $('song-list');

  // Clean up trash actions bar when not in trash view
  if (currentFolder !== 'Recently Deleted') {
    const trashBar = $('trash-actions-bar');
    if (trashBar) trashBar.remove();
  }

  // Trash view
  if (currentFolder === 'Recently Deleted') {
    return renderTrashList(el, filter);
  }

  let list = songs;
  if (currentFolder === 'Recently Edited') {
    list = songs.filter(s => {
      const d = new Date(s.updated_at || s.created_at || 0);
      return Date.now() - d.getTime() < 7 * 86400000;
    });
  } else if (currentFolder !== 'All Songs') {
    list = songs.filter(s => s.folder === currentFolder);
  }

  if (filter) {
    const q = filter.toLowerCase();
    list = list.filter(s => {
      if (s.title?.toLowerCase().includes(q)) return true;
      // Search within song content too
      if (s.key?.toLowerCase().includes(q)) return true;
      if (s.sections?.some(sec => sec.lines?.some(l => l.text?.toLowerCase().includes(q)))) return true;
      if (s.tags?.some(t => t.toLowerCase().includes(q))) return true;
      // Search chord names (musicians often remember progressions, not titles)
      if (s.sections?.some(sec => sec.lines?.some(l => l.chords?.some(c => c.name?.toLowerCase().includes(q))))) return true;
      return false;
    });
  }

  // Tag filter
  if (activeTagFilter) {
    list = list.filter(s => s.tags?.includes(activeTagFilter));
  }

  if (!list.length) {
    const isFilter = !!filter;
    const iconSvg = isFilter ? ICONS.search : ICONS.music;
    const title = isFilter ? 'No Results' : 'No Songs Yet';
    const desc = isFilter
      ? `No songs match "${escHtml(filter)}". Try a different search term.`
      : 'Create your first song to get started';
    const cta = isFilter ? '' : '<button class="empty-cta" id="empty-create-btn">Create Song</button>';
    el.innerHTML = emptyStateHTML({ iconSvg, title, desc, cta });
    const ctaBtn = $('empty-create-btn');
    if (ctaBtn) ctaBtn.addEventListener('click', () => { if (typeof showNewSongSheet === 'function') showNewSongSheet(); });
    return;
  }

  // Sort
  const SORT_MODES = { recent: 'Recent', 'title-az': 'A → Z', 'title-za': 'Z → A', key: 'Key', bpm: 'BPM' };
  const sorted = [...list].sort((a, b) => {
    // Pinned always first
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (activeSortMode === 'title-az') return (a.title || '').localeCompare(b.title || '');
    if (activeSortMode === 'title-za') return (b.title || '').localeCompare(a.title || '');
    if (activeSortMode === 'key') {
      const ka = (a.key || 'ZZZ').toLowerCase(), kb = (b.key || 'ZZZ').toLowerCase();
      return ka.localeCompare(kb);
    }
    if (activeSortMode === 'bpm') {
      const ba = a.bpm || 0, bb = b.bpm || 0;
      return ba - bb;
    }
    // recent (default)
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });

  // Gallery mode: flat card grid (no date sections)
  if (galleryMode) {
    let html = '';
    sorted.forEach((s, i) => {
      const pinned = s.pinned ? '<span class="card-pin">★</span>' : '';
      const keyBadge = s.key ? `<span class="card-key">${esc(s.key)}</span>` : '';
      const bpmBadge = s.bpm ? `<span class="card-bpm">${esc(String(s.bpm))}</span>` : '';
      const tutorialBadge = s.tutorial ? '<span class="tutorial-badge">Tutorial</span>' : '';
      const secCount = s.sections?.length || 0;
      const secLabel = secCount === 1 ? 'section' : 'sections';
      // Extract unique chords for preview (up to 6)
      const chordSet = [];
      if (s.sections) {
        for (const sec of s.sections) {
          if (sec.lines) for (const l of sec.lines) {
            if (l.chords) for (const c of l.chords) {
              if (c.name && !chordSet.includes(c.name)) chordSet.push(c.name);
              if (chordSet.length >= 6) break;
            }
            if (chordSet.length >= 6) break;
          }
          if (chordSet.length >= 6) break;
        }
      }
      const chordPreview = chordSet.length ? `<div class="card-chords">${chordSet.map(c => `<span class="card-chord-chip">${esc(c)}</span>`).join('')}</div>` : '';
      const tagHtml = (s.tags && s.tags.length) ? `<div class="card-tags">${s.tags.slice(0, 3).map(t => `<span class="card-tag">${highlightMatch(t, filter)}</span>`).join('')}${s.tags.length > 3 ? `<span class="card-tag-more">+${s.tags.length - 3}</span>` : ''}</div>` : '';
      const pinLabel = s.pinned ? '☆' : '★';
      // Writing time for gallery card
      const gwtH = Math.floor((s.session_ms || 0) / 3600000);
      const gwtM = Math.floor(((s.session_ms || 0) % 3600000) / 60000);
      const galleryWritingTime = (s.session_ms || 0) > 0
        ? `<span class="card-writing-time" title="Writing time">${gwtH > 0 ? gwtH + 'h ' + gwtM + 'm' : gwtM + 'm'}</span>`
        : '';
      html += `<div class="gallery-card${multiSelectMode && selectedSongIds.has(s.id) ? ' selected' : ''}" data-id="${s.id}" role="option" aria-selected="${multiSelectMode && selectedSongIds.has(s.id) ? 'true' : 'false'}" style="animation-delay:${i * 30}ms">
        <div class="gallery-card-top">
          ${pinned}
          <span class="card-title">${highlightMatch(s.title || 'Untitled', filter)}</span>
          ${keyBadge}
          ${bpmBadge}
          ${tutorialBadge}
        </div>
        ${chordPreview}
        <div class="gallery-card-bottom">
          <span class="card-meta">${secCount} ${secLabel}</span>
          <span class="card-date">${fmtDate(s.updated_at)}</span>
          ${galleryWritingTime}
        </div>
        ${tagHtml}
        <div class="gallery-card-actions">
          <button class="gallery-card-pin" data-action="pin" aria-label="${s.pinned ? 'Unpin' : 'Pin'}">${pinLabel}</button>
          <button class="gallery-card-delete" data-action="delete" aria-label="Delete">✕</button>
        </div>
      </div>`;
    });
    el.innerHTML = html;

    // Events handled by delegated listener on #song-list (initSongListDelegation)
    return;
  }

  // List mode: virtual scrolling for performance with large lists
  initVirtualScroll();
  const totalHeight = buildVirtualItems(sorted);

  // Set the spacer height so the scrollbar reflects the full list
  el.style.minHeight = totalHeight + 'px';
  el.style.position = 'relative';

  // Render initial visible items
  currentSearchFilter = filter;
  renderVirtualItems(filter);

  // Update tag filter bar
  renderTagFilterBar();
}

// Editor

// Get the sorted list of songs currently shown in the song list (mirrors renderSongList logic)
function getCurrentSongList() {
  let list = songs;
  if (currentFolder === 'Recently Edited') {
    list = list.filter(s => {
      const d = new Date(s.updated_at || s.created_at || 0);
      return Date.now() - d.getTime() < 7 * 86400000;
    });
  } else if (currentFolder !== 'All Songs') {
    list = list.filter(s => s.folder === currentFolder);
  }
  // Note: does NOT apply search filter — switcher navigates the full folder list
  if (activeTagFilter) {
    list = list.filter(s => s.tags?.includes(activeTagFilter));
  }
  const sorted = [...list].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (activeSortMode === 'title-az') return (a.title || '').localeCompare(b.title || '');
    if (activeSortMode === 'title-za') return (b.title || '').localeCompare(a.title || '');
    if (activeSortMode === 'key') {
      const ka = (a.key || 'ZZZ').toLowerCase(), kb = (b.key || 'ZZZ').toLowerCase();
      return ka.localeCompare(kb);
    }
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });
  return sorted;
}

function switchToSong(targetId, direction) {
  const song = getSong(targetId);
  if (!song || targetId === currentSongId) return;
  // Save current song title and flush pending auto-save
  const currentSong = getSong(currentSongId);
  if (currentSong) {
    currentSong.title = $('song-title').value || 'Untitled';
    currentSong.updated_at = new Date().toISOString();
    // Flush any pending auto-save timer to avoid stale writes after switch
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    saveSingleSong(currentSong);
    hasChanges = false;
    if ($('save-btn')) $('save-btn').disabled = true;
    updateSaveDot('saved');
  }
  stopSessionTimer();
  // Stop metronome if playing to avoid background interval after navigation
  if (isMetroPlaying()) metroStop();
  // Stop tuner if active to avoid background audio processing
  if (tunerActive) stopTuner();
  // Clear undo buffer from previous song to prevent stale restores
  clearUndo();
  // Apply slide transition on the editor view
  const editorView = $('editor-view');
  const isForward = direction === 'forward';
  editorView.classList.add(isForward ? 'slide-in-right' : 'slide-in-left');
  void editorView.offsetWidth;
  editorView.style.transition = 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.3s ease';
  editorView.style.opacity = '0.6';
  editorView.style.transform = isForward ? 'translateX(-30%)' : 'translateX(30%)';
  requestAnimationFrame(() => {
    editorView.style.transform = 'translateX(0)';
    editorView.style.opacity = '1';
  });
  const onEnd = () => {
    editorView.removeEventListener('transitionend', onEnd);
    editorView.style.transition = '';
    editorView.style.opacity = '';
    editorView.style.transform = '';
    editorView.classList.remove('slide-in-left', 'slide-in-right');
  };
  editorView.addEventListener('transitionend', onEnd);
  setTimeout(onEnd, 380);
  // Now load the new song
  currentSongId = targetId;
  safeStorageSet('songs_app_last', currentSongId);
  openEditor(targetId);
  updateSwitcherButtons();
}

function prevSong() {
  const list = getCurrentSongList();
  if (!list.length) return;
  const idx = list.findIndex(s => s.id === currentSongId);
  const prevIdx = idx <= 0 ? list.length - 1 : idx - 1;
  switchToSong(list[prevIdx].id, 'back');
}

function nextSong() {
  const list = getCurrentSongList();
  if (!list.length) return;
  const idx = list.findIndex(s => s.id === currentSongId);
  const nextIdx = idx >= list.length - 1 ? 0 : idx + 1;
  switchToSong(list[nextIdx].id, 'forward');
}

function updateSwitcherButtons() {
  const list = getCurrentSongList();
  const hasMultiple = list.length > 1;
  const prevBtn = $('prev-song-btn');
  const nextBtn = $('next-song-btn');
  if (prevBtn) prevBtn.disabled = !hasMultiple;
  if (nextBtn) nextBtn.disabled = !hasMultiple;
}

function openEditor(id) {
  const song = getSong(id);
  if (!song) return;
  $('song-title').value = song.title;
  versionHistory = [];
  hasChanges = false;
  $('save-btn').disabled = true;
  updateUndoBtn();
  clearSectionLabel();
  renderEditorBody(song);
  updateRecordUI();
  updateSaveDot('saved');
  // Update info bar if visible
  const infoBar = $('info-bar');
  if (infoBar && infoBar.style.display === 'flex') updateInfoBar();
  // Update set-key button text in more menu
  const keyBtn = $('more-menu')?.querySelector('[data-action="set-key"]');
  if (keyBtn) keyBtn.textContent = song.key ? `Set Key: ${song.key}` : 'Set Key: —';
  // Update key+BPM badge in nav bar
  updateEditorKeyBpm(song);
  // Start session timer
  startSessionTimer();
  // Update switcher button state
  updateSwitcherButtons();
  // Show section nav button only for songs with 3+ sections
  const _snBtn = $('section-nav-btn');
  if (_snBtn) _snBtn.style.display = (song.sections && song.sections.length >= 3) ? '' : 'none';
}

// Update the key+BPM+capo badge in the editor nav bar
function updateEditorKeyBpm(song) {
  const badge = $('editor-key-bpm');
  if (!badge) return;
  if (!song) { badge.style.display = 'none'; return; }
  const key = song.key || '';
  const bpm = song.bpm || '';
  const capo = song.capo || 0;
  if (!key && !bpm && !capo) { badge.style.display = 'none'; return; }
  const parts = [];
  if (key) parts.push(`<span class="k">${esc(key)}</span>`);
  if (bpm) parts.push(`<span class="b">${esc(String(bpm))}</span>`);
  if (capo) parts.push(`<span class="c">capo ${capo}</span>`);
  badge.innerHTML = parts.join(`<span class="s">·</span>`);
  badge.style.display = '';
  const labels = [];
  if (key) labels.push('Key: ' + key);
  if (bpm) labels.push('BPM: ' + bpm);
  if (capo) labels.push('Capo: ' + capo);
  badge.setAttribute('aria-label', labels.join(', '));
}

// ===== Lazy Section Rendering =====
// For large songs (40+ sections), use IntersectionObserver to render sections on demand.
// Off-screen sections are replaced with height-preserving placeholders to avoid jank.
let sectionObserver = null;
let sectionObserverSongId = null;

function getSectionEstimatedHeight(section) {
  // Estimate height: header (~46px) + lines (~34px each) + add-line btn (~36px) + margin (28px)
  const lineCount = section.lines ? section.lines.length : 1;
  return 46 + (lineCount * 34) + 36 + 28;
}

function initSectionObserver(song, el) {
  if (sectionObserver) { sectionObserver.disconnect(); sectionObserver = null; }
  sectionObserverSongId = song.id;
  sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const idx = parseInt(entry.target.dataset.sectionIdx);
      if (isNaN(idx)) return;
      if (entry.isIntersecting && entry.target.classList.contains('section-placeholder')) {
        // Render real section
        const section = song.sections[idx];
        if (!section) return;
        const realEl = buildSectionElement(song, idx, section);
        entry.target.replaceWith(realEl);
        // Observe the real element for going out of view
        sectionObserver.observe(realEl);
      } else if (!entry.isIntersecting && !entry.target.classList.contains('section-placeholder')) {
        // Far out of view — replace with placeholder (only if > 500px from viewport)
        const rect = entry.target.getBoundingClientRect();
        const viewportH = window.innerHeight;
        if (rect.bottom < -500 || rect.top > viewportH + 500) {
          const placeholder = createSectionPlaceholder(idx, entry.target.offsetHeight);
          entry.target.replaceWith(placeholder);
          sectionObserver.observe(placeholder);
        }
      }
    });
  }, { root: el, rootMargin: '200px 0px', threshold: 0 });
}

function createSectionPlaceholder(idx, height) {
  const div = document.createElement('div');
  div.className = 'song-section section-placeholder';
  div.dataset.sectionIdx = idx;
  div.style.height = height + 'px';
  div.style.minHeight = '60px';
  div.style.display = 'flex';
  div.style.alignItems = 'center';
  div.style.justifyContent = 'center';
  div.style.opacity = 0.3;
  div.style.fontSize = '11px';
  div.style.letterSpacing = '0.5px';
  div.style.color = 'var(--text-secondary)';
  div.textContent = songSections[idx] ? songSections[idx].type || 'Section' : '⋯';
  return div;
}

// Reference to song sections for placeholder labels (set during renderEditorBody)
let songSections = [];

function renderEditorBody(song) {
  const el = $('song-body');
  el.innerHTML = '';
  songSections = song.sections;

  // For small songs, render all sections normally (fast enough)
  if (song.sections.length <= 30) {
    song.sections.forEach((section, si) => {
      const sectionEl = buildSectionElement(song, si, section);
      el.appendChild(sectionEl);
    });
  } else {
    // Large song: lazy rendering with IntersectionObserver
    initSectionObserver(song, el);
    // Render first 3 sections immediately so the user sees content right away
    const initialCount = Math.min(3, song.sections.length);
    for (let si = 0; si < initialCount; si++) {
      const sectionEl = buildSectionElement(song, si, song.sections[si]);
      el.appendChild(sectionEl);
      sectionObserver.observe(sectionEl);
    }
    // Placeholder for remaining sections
    for (let si = initialCount; si < song.sections.length; si++) {
      const estimatedH = getSectionEstimatedHeight(song.sections[si]);
      const placeholder = createSectionPlaceholder(si, estimatedH);
      el.appendChild(placeholder);
      sectionObserver.observe(placeholder);
    }
  }

  renderChordRibbon(song);
  applyDisplayMode();
  applyEditorFontSize();
  // Update section nav button visibility
  const _snBtn2 = $('section-nav-btn');
  if (_snBtn2) _snBtn2.style.display = (song.sections && song.sections.length >= 3) ? '' : 'none';
}

// Build a single section DOM element (extracted from the old forEach)
function buildSectionElement(song, si, section) {
    const tmpl = $('section-template').content.cloneNode(true);
    const sectionEl = tmpl.querySelector('.song-section');
    sectionEl.dataset.sectionIdx = si;
    // Normalize section type for color coding (strip numbers/suffixes, lowercase)
    const typeKey = (section.type || 'Verse').replace(/\s+\d+$/, '').toLowerCase().replace(/[^a-z]/g, '-');
    sectionEl.dataset.sectionType = typeKey;
    const typeInput = tmpl.querySelector('.section-type-input');
    if (typeInput) {
      typeInput.value = section.type || 'Verse';

      // Auto-capitalize: match typed input against known section types
      const knownTypes = ['Verse', 'Verse 2', 'Chorus', 'Pre-Chorus', 'Bridge', 'Tag', 'Coda', 'Outro', 'Intro'];
      function autoCapitalize(val) {
        const lower = val.toLowerCase().trim();
        if (!lower) return;
        const match = knownTypes.find(t => t.toLowerCase() === lower);
        if (match && typeInput.value !== match) {
          typeInput.value = match;
          song.sections[si].type = match;
          triggerAutoSave(song);
          return true;
        }
        // Also match partial prefix: "vers" -> "Verse", "chor" -> "Chorus"
        const prefixMatch = knownTypes.find(t => t.toLowerCase().startsWith(lower) && lower.length >= 2);
        if (prefixMatch) {
          // Don't auto-replace while still typing (wait for exact or longer match), but capitalize first letter of each word
          const words = val.split(/\s+/);
          const capitalized = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          if (capitalized !== val) {
            typeInput.value = capitalized;
            // Move cursor to end
            setTimeout(() => { typeInput.selectionStart = typeInput.selectionEnd = typeInput.value.length; }, 0);
          }
        }
        return false;
      }

      typeInput.addEventListener('input', () => {
        const prev = song.sections[si].type;
        const val = typeInput.value;
        song.sections[si].type = val;
        autoCapitalize(val);
        // Update color coding data attribute
        const typeKey = val.replace(/\s+\d+$/, '').toLowerCase().replace(/[^a-z]/g, '-');
        sectionEl.dataset.sectionType = typeKey;
        if (song.sections[si].type !== prev) triggerAutoSave(song);
      });
      typeInput.addEventListener('change', () => {
        // On blur/enter, do a final capitalize pass
        const matched = autoCapitalize(typeInput.value);
        if (!matched) {
          // If no known match, still capitalize first letter of each word
          const val = typeInput.value;
          const words = val.split(/\s+/);
          const capitalized = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
          if (capitalized !== val) {
            typeInput.value = capitalized;
            song.sections[si].type = capitalized;
          }
        }
        triggerAutoSave(song);
      });
    }

    tmpl.querySelector('.delete-section').addEventListener('click', () => {
      if (song.sections.length <= 1) { toast('Need at least one section'); return; }
      const deletedSection = song.sections[si];
      const deletedIndex = si;
      song.sections.splice(si, 1);
      saveSingleSong(song); renderEditorBody(song);
      undoBuffer = {
        type: 'section', songId: song.id,
        restore: () => {
          const s = getSong(song.id);
          if (!s) return;
          s.sections.splice(deletedIndex, 0, JSON.parse(JSON.stringify(deletedSection)));
          s.updated_at = new Date().toISOString();
          saveSingleSong(s); renderEditorBody(s);
          toast('Section restored', 'success');
        }
      };
      showUndoToast('Section deleted');
    });
    tmpl.querySelector('.move-up').addEventListener('click', () => {
      if (si <= 0) return;
      [song.sections[si-1], song.sections[si]] = [song.sections[si], song.sections[si-1]];
      saveSingleSong(song); renderEditorBody(song);
    });
    tmpl.querySelector('.move-down').addEventListener('click', () => {
      if (si >= song.sections.length - 1) return;
      [song.sections[si], song.sections[si+1]] = [song.sections[si+1], song.sections[si]];
      saveSingleSong(song); renderEditorBody(song);
    });
    tmpl.querySelector('.duplicate-section').addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(song.sections[si]));
      song.sections.splice(si + 1, 0, copy);
      saveSingleSong(song); renderEditorBody(song);
    });

    // Strumming pattern toggle + input
    const strummingDiv = tmpl.querySelector('.section-strumming');
    const strummingInput = tmpl.querySelector('.strumming-input');
    const strummingClear = tmpl.querySelector('.strumming-clear');
    const toggleStrumBtn = tmpl.querySelector('.toggle-strumming');
    if (strummingDiv && strummingInput && toggleStrumBtn) {
      // Initialize from data
      if (section.strumming) {
        strummingDiv.style.display = 'flex';
        strummingInput.value = section.strumming;
        toggleStrumBtn.classList.add('active');
      }
      toggleStrumBtn.addEventListener('click', () => {
        const visible = strummingDiv.style.display !== 'none';
        strummingDiv.style.display = visible ? 'none' : 'flex';
        toggleStrumBtn.classList.toggle('active', !visible);
        if (!visible) { strummingInput.focus(); strummingInput.select(); }
        if (visible) {
          // Hiding — clear value
          strummingInput.value = '';
          section.strumming = null;
          triggerAutoSave(song);
        }
      });
      strummingInput.addEventListener('input', () => {
        const val = strummingInput.value.trim();
        section.strumming = val || null;
        triggerAutoSave(song);
      });
      if (strummingClear) {
        strummingClear.addEventListener('click', () => {
          strummingInput.value = '';
          section.strumming = null;
          triggerAutoSave(song);
          strummingInput.focus();
        });
      }
    }

    // Drag to reorder
    sectionEl.draggable = true;
    const songBodyEl = $('song-body');
    sectionEl.addEventListener('dragstart', e => { sectionEl.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; });
    sectionEl.addEventListener('dragover', e => { e.preventDefault(); sectionEl.classList.add('drag-over'); });
    sectionEl.addEventListener('dragleave', () => sectionEl.classList.remove('drag-over'));
    sectionEl.addEventListener('drop', e => {
      e.preventDefault(); sectionEl.classList.remove('drag-over');
      const children = [...songBodyEl.children];
      const fromIdx = children.indexOf(document.querySelector('.song-section[draggable]'));
      if (fromIdx !== -1) {
        const [removed] = song.sections.splice(fromIdx, 1);
        song.sections.splice(children.indexOf(sectionEl), 0, removed);
        saveSingleSong(song); renderEditorBody(song);
      }
    });
    sectionEl.addEventListener('dragend', () => { sectionEl.style.opacity = '1'; document.querySelectorAll('.song-section').forEach(s => s.draggable = false); setTimeout(() => document.querySelectorAll('.song-section').forEach(s => s.draggable = true), 100); });

    // Lines
    const editorDiv = tmpl.querySelector('.section-editor');
    section.lines.forEach((line, li) => renderLine(editorDiv, song, si, li, line));

    const addLineBtn = document.createElement('button');
    addLineBtn.className = 'add-line-btn';
    addLineBtn.textContent = '+ Line';
    addLineBtn.addEventListener('click', () => {
      song.sections[si].lines.push({ text: '', chords: [] });
      saveSingleSong(song); renderLine(editorDiv, song, si, song.sections[si].lines.length - 1, { text: '', chords: [] });
    });
    editorDiv.appendChild(addLineBtn);
    return sectionEl;
}

function applyDisplayMode() {
  const body = $('song-body');
  if (!body) return;
  body.classList.remove('display-both', 'display-lyrics', 'display-chords');
  if (displayMode === 'lyrics') body.classList.add('display-lyrics');
  else if (displayMode === 'chords') body.classList.add('display-chords');
  else body.classList.add('display-both');
}

function cycleDisplayMode() {
  const modes = ['both', 'lyrics', 'chords'];
  const idx = modes.indexOf(displayMode);
  displayMode = modes[(idx + 1) % modes.length];
  safeStorageSet('sn_displayMode', displayMode);
  applyDisplayMode();
  const labels = { both: 'Chords + Lyrics', lyrics: 'Lyrics Only', chords: 'Chords Only' };
  toast(labels[displayMode]);
}

function applyEditorFontSize() {
  const body = $('song-body');
  if (!body) return;
  body.style.setProperty('--editor-font-size', editorFontSize + 'px');
  // Also update chord ribbon item names to scale
  const ribbonItems = document.querySelectorAll('.chord-ribbon-item .chord-name');
  ribbonItems.forEach(el => {
    el.style.fontSize = `calc(var(--editor-font-size) * 0.77)`;
  });
}

function adjustFontSize(delta) {
  const newSize = Math.max(13, Math.min(24, editorFontSize + delta));
  if (newSize === editorFontSize) return;
  editorFontSize = newSize;
  safeStorageSet('sn_editorFontSize', editorFontSize);
  applyEditorFontSize();
  toast(`Font size: ${editorFontSize}px`);
}

function renderChordRibbon(song) {
  const ribbon = $('chord-ribbon');
  if (!ribbon) return;

  // Collect all unique chords in order with section labels
  const seen = new Set();
  const items = [];
  song.sections.forEach(sec => {
    sec.lines.forEach(line => {
      line.chords.forEach(ch => {
        if (!ch.name || seen.has(ch.name)) return;
        seen.add(ch.name);
        items.push({ name: ch.name, section: sec.type });
      });
    });
  });

  if (!items.length) { ribbon.innerHTML = ''; return; }

  // Collapse toggle button
  const toggle = document.createElement('button');
  toggle.className = 'chord-ribbon-toggle';
  toggle.textContent = chordRibbonCollapsed ? '▸' : '▾';
  toggle.setAttribute('aria-label', chordRibbonCollapsed ? 'Expand chord ribbon' : 'Collapse chord ribbon');
  toggle.addEventListener('click', () => {
    chordRibbonCollapsed = !chordRibbonCollapsed;
    safeStorageSet('chordRibbonCollapsed', chordRibbonCollapsed);
    toggle.textContent = chordRibbonCollapsed ? '▸' : '▾';
    toggle.setAttribute('aria-label', chordRibbonCollapsed ? 'Expand chord ribbon' : 'Collapse chord ribbon');
    ribbon.classList.toggle('collapsed', chordRibbonCollapsed);
  });

  const scroll = document.createElement('div');
  scroll.className = 'chord-ribbon-scroll';
  scroll.innerHTML = items.map(item =>
    `<div class="chord-ribbon-item" data-chord="${esc(item.name)}"><span class="chord-name">${esc(item.name)}</span><span class="chord-section">${esc(item.section)}</span></div>`
  ).join('');

  ribbon.innerHTML = '';
  ribbon.appendChild(scroll);
  ribbon.appendChild(toggle);
  ribbon.classList.toggle('collapsed', chordRibbonCollapsed);

  // Tap to highlight & scroll to first occurrence
  scroll.querySelectorAll('.chord-ribbon-item').forEach(el => {
    el.addEventListener('click', () => {
      const chordName = el.dataset.chord;
      // Highlight matching chord markers in the editor
      document.querySelectorAll('.chord-marker').forEach(m => {
        m.classList.toggle('chord-highlight', m.textContent === chordName);
      });
      // Scroll to first matching occurrence
      const markers = document.querySelectorAll('.chord-marker');
      for (const m of markers) {
        if (m.textContent === chordName) {
          m.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
      // Remove highlight after 2s
      setTimeout(() => {
        document.querySelectorAll('.chord-marker.chord-highlight').forEach(m => m.classList.remove('chord-highlight'));
      }, 2000);
    });
  });
}

function renderLine(container, song, si, li, line) {
  const lineEl = document.createElement('div');
  lineEl.className = 'chord-line';

  // Chord row — click to add/position chords
  const chordRow = document.createElement('div');
  chordRow.className = 'chord-row';

  // Lyric input — click to type
  const lyricInput = document.createElement('div');
  lyricInput.className = 'lyric-text';
  lyricInput.contentEditable = true;
  lyricInput.dataset.placeholder = 'Lyrics';
  lyricInput.textContent = line.text;

  // Inline chord detection: when user types [G] or [Am] etc in lyrics, auto-convert to chord marker
  const INLINE_CHORD_RE = /\[([A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G][#b]?)?)\]/g;
  let inlineChordCooldown = false;

  lyricInput.addEventListener('input', () => {
    const text = lyricInput.textContent;

    // Check for inline chord notation like [G], [Am], [F#m7], [D/F#]
    let match;
    let found = false;
    INLINE_CHORD_RE.lastIndex = 0;
    while ((match = INLINE_CHORD_RE.exec(text)) !== null) {
      const chordName = match[1];
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;

      // Measure pixel position of the chord in the lyric text
      const chordX = measureTextWidthUpTo(matchStart);

      // Check if a chord already exists near this position (within 20px)
      const existingNear = line.chords.find(c => Math.abs(c.x - chordX) < 20);
      if (!existingNear) {
        line.chords.push({ x: chordX, name: chordName });
        line.chords.sort((a, b) => a.x - b.x);
      }

      found = true;
    }

    if (found) {
      // Remove the bracket chord notation from text
      const cleanText = text.replace(INLINE_CHORD_RE, '').trimStart();
      line.text = cleanText;
      lyricInput.textContent = cleanText;

      // Save and refresh chord markers
      saveSingleSong(song);
      renderChordMarkers();

      // Show toast (throttled to avoid spam)
      if (!inlineChordCooldown) {
        inlineChordCooldown = true;
        toast('Chord added from text', 'success');
        setTimeout(() => { inlineChordCooldown = false; }, 1500);
      }
    } else {
      line.text = text;
      triggerAutoSave(song);
    }
  });

  // Measure pixel width of text up to a given character offset in the lyric input
  // Uses Range.getBoundingClientRect() for accurate measurement regardless of font/size
  function measureTextWidthUpTo(offset) {
    if (!offset) return 0;
    const textNode = lyricInput.firstChild;
    if (!textNode) return 0;
    // Clamp offset to text length to avoid Range exceptions
    const len = textNode.textContent.length;
    const clamped = Math.min(offset, len);
    if (clamped <= 0) return 0;
    try {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, clamped);
      const rect = range.getBoundingClientRect();
      // Use the right edge relative to the lyric input's left edge
      const inputRect = lyricInput.getBoundingClientRect();
      return Math.max(0, Math.round(rect.right - inputRect.left));
    } catch {
      // Fallback: estimate from computed character width
      const cs = getComputedStyle(lyricInput);
      const fontSize = parseFloat(cs.fontSize) || editorFontSize;
      return Math.round(offset * fontSize * 0.55);
    }
  }

  // Measure pixel width of a line's text using a temporary canvas (works for any line, not just the active input)
  function measureTextFromLine(line) {
    if (!line || !line.text) return 0;
    try {
      const cs = getComputedStyle(lyricInput);
      const fontSize = parseFloat(cs.fontSize) || editorFontSize;
      const fontFamily = cs.fontFamily || 'var(--font)';
      // Use canvas 2D context for fast text measurement without DOM manipulation
      if (!measureTextFromLine._ctx) {
        const canvas = document.createElement('canvas');
        measureTextFromLine._ctx = canvas.getContext('2d');
      }
      measureTextFromLine._ctx.font = `${fontSize}px ${fontFamily}`;
      return Math.round(measureTextFromLine._ctx.measureText(line.text).width);
    } catch {
      return line.text.length * 8; // last-resort fallback
    }
  }

  // Enter = split line, preserving chords
  lyricInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection();
      const focusOffset = sel?.focusOffset || 0;
      const textBefore = lyricInput.textContent.substring(0, focusOffset);
      const textAfter = lyricInput.textContent.substring(focusOffset);
      lyricInput.textContent = textBefore;
      const cursorX = measureTextWidthUpTo(focusOffset);
      // Chords before cursor stay, chords after move to new line
      const chordsBefore = line.chords.filter(c => c.x < cursorX);
      const chordsAfter = line.chords.filter(c => c.x >= cursorX).map(c => ({ ...c, x: c.x - cursorX }));
      line.chords = chordsBefore;
      song.sections[si].lines.splice(li + 1, 0, { text: textAfter, chords: chordsAfter });
      saveSingleSong(song);
      renderEditorBody(song);
    }
    // Backspace at start of line = merge with previous line
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      const cursorPos = sel?.focusOffset || 0;
      // Only merge if cursor is at position 0 and there's text content to merge
      if (cursorPos === 0 && lyricInput.textContent.length > 0) {
        // Check if selection is collapsed (no text selected)
        if (sel && sel.isCollapsed) {
          e.preventDefault();
          e.stopPropagation();
          const section = song.sections[si];
          // Find the previous line (could be in a previous section)
          let prevLine = null;
          let prevSi = si, prevLi = li;
          if (li > 0) {
            prevLi = li - 1;
            prevLine = section.lines[prevLi];
          } else if (si > 0) {
            prevSi = si - 1;
            const prevSection = song.sections[prevSi];
            prevLi = prevSection.lines.length - 1;
            prevLine = prevSection.lines[prevLi];
          }
          if (prevLine) {
            // Measure actual pixel width of previous line's text for accurate chord offset
            const prevLineWidth = measureTextFromLine(prevLine);
            // Append current line text to previous line
            prevLine.text += lyricInput.textContent;
            // Merge chords: offset current chords by measured previous line text width
            const mergedChords = [
              ...(prevLine.chords || []),
              ...(line.chords || []).map(c => ({ ...c, x: c.x + prevLineWidth }))
            ];
            prevLine.chords = mergedChords;
            // Remove current line from section
            section.lines.splice(li, 1);
            // If section is now empty, remove it
            if (section.lines.length === 0 && song.sections.length > 1) {
              song.sections.splice(si, 1);
            }
            saveSingleSong(song);
            renderEditorBody(song);
            // Position cursor at the join point in the previous line
            setTimeout(() => {
              const prevInput = $(`[data-si="${prevSi}"][data-li="${prevLi}"] .lyric-text`);
              if (prevInput) {
                prevInput.focus();
                const range = document.createRange();
                const textNode = prevInput.firstChild;
                if (textNode) {
                  range.setStart(textNode, prevLineLen);
                  range.collapse(true);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }
            }, 50);
          }
        }
      }
    }
  });

  // Render chord markers in the chord row
  function renderChordMarkers() {
    chordRow.innerHTML = '';
    line.chords.forEach((ch, i) => {
      if (!ch.name) return;
      const marker = document.createElement('span');
      marker.className = 'chord-marker';
      marker.textContent = ch.name;
      marker.style.left = ch.x + 'px';
      marker.dataset.chordIdx = i;
      marker.dataset.chordName = ch.name;

      // Tap to edit
      marker.addEventListener('click', e => {
        e.stopPropagation();
        showChordEdit(song, line, ch);
      });

      // Long press to delete
      let longPressTimer = null;
      let longPressChord = null;
      marker.addEventListener('touchstart', e => {
        longPressChord = ch;
        longPressTimer = setTimeout(() => {
          marker.classList.add('chord-marker-deleting');
          haptic(50);
          showConfirmSheet({
            title: 'Delete Chord',
            body: `Delete chord "${ch.name}"?`,
            confirmText: 'Delete',
            onConfirm: () => {
              line.chords = line.chords.filter(c => c !== longPressChord);
              saveSingleSong(song);
              renderChordMarkers();
            }
          });
          marker.classList.remove('chord-marker-deleting');
          longPressTimer = null;
        }, 600);
      }, { passive: true });
      marker.addEventListener('touchend', () => { clearTimeout(longPressTimer); longPressTimer = null; }, { passive: true });
      marker.addEventListener('touchmove', () => { clearTimeout(longPressTimer); longPressTimer = null; }, { passive: true });

      // Drag to move chord position
      let dragStartX = 0;
      let dragChordStartX = 0;
      let isDragging = false;

      marker.addEventListener('touchstart', e => {
        const touch = e.touches[0];
        dragStartX = touch.clientX;
        dragChordStartX = ch.x;
        isDragging = false;
        marker.classList.add('chord-marker-dragging');
      }, { passive: true });

      marker.addEventListener('touchmove', e => {
        if (!isDragging) {
          // Only start drag if moved > 8px
          const touch = e.touches[0];
          if (Math.abs(touch.clientX - dragStartX) > 8) {
            isDragging = true;
          }
        }
        if (isDragging) {
          e.preventDefault();
          const touch = e.touches[0];
          const rect = chordRow.getBoundingClientRect();
          const deltaX = touch.clientX - dragStartX;
          const newX = Math.max(0, Math.round(dragChordStartX + deltaX));
          ch.x = newX;
          marker.style.left = newX + 'px';
          marker.classList.add('chord-marker-dragging');
        }
      }, { passive: false });

      marker.addEventListener('touchend', () => {
        marker.classList.remove('chord-marker-dragging');
        if (isDragging) {
          line.chords.sort((a, b) => a.x - b.x);
          saveSingleSong(song);
          renderChordMarkers();
        }
        isDragging = false;
      }, { passive: true });

      // Mouse drag support (for desktop testing)
      marker.addEventListener('mousedown', e => {
        e.preventDefault();
        dragStartX = e.clientX;
        dragChordStartX = ch.x;
        isDragging = false;
        marker.classList.add('chord-marker-dragging');

        function onMouseMove(e) {
          if (!isDragging && Math.abs(e.clientX - dragStartX) > 8) isDragging = true;
          if (isDragging) {
            const deltaX = e.clientX - dragStartX;
            const newX = Math.max(0, Math.round(dragChordStartX + deltaX));
            ch.x = newX;
            marker.style.left = newX + 'px';
          }
        }
        function onMouseUp() {
          marker.classList.remove('chord-marker-dragging');
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          if (isDragging) {
            line.chords.sort((a, b) => a.x - b.x);
            saveSingleSong(song);
            renderChordMarkers();
          }
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      chordRow.appendChild(marker);
    });
    // Line action buttons (always at end of chord row)
    // Duplicate line button
    const dupBtn = document.createElement('button');
    dupBtn.className = 'line-dup-btn';
    dupBtn.textContent = '⧉';
    dupBtn.addEventListener('click', e => {
      e.stopPropagation();
      const copy = JSON.parse(JSON.stringify(line));
      song.sections[si].lines.splice(li + 1, 0, copy);
      saveSingleSong(song); renderEditorBody(song);
      undoBuffer = {
        type: 'line-dup', songId: song.id, sectionIndex: si, lineIndex: li + 1,
        restore: () => {
          const s = getSong(song.id);
          if (!s || !s.sections[si]) return;
          s.sections[si].lines.splice(li + 1, 1);
          s.updated_at = new Date().toISOString();
          saveSingleSong(s); renderEditorBody(s);
          toast('Line duplication undone', 'success');
        }
      };
      showUndoToast('Line duplicated');
    });
    chordRow.appendChild(dupBtn);

    // Delete line button
    const delBtn = document.createElement('button');
    delBtn.className = 'line-delete-btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      const deletedLine = song.sections[si].lines[li];
      const deletedLineIndex = li;
      song.sections[si].lines.splice(li, 1);
      saveSingleSong(song); renderEditorBody(song);
      undoBuffer = {
        type: 'line', songId: song.id, sectionIndex: si, lineIndex: deletedLineIndex,
        deletedLine: JSON.parse(JSON.stringify(deletedLine)),
        restore: () => {
          const s = getSong(song.id);
          if (!s || !s.sections[si]) return;
          s.sections[si].lines.splice(deletedLineIndex, 0, JSON.parse(JSON.stringify(deletedLine)));
          s.updated_at = new Date().toISOString();
          saveSingleSong(s); renderEditorBody(s);
          toast('Line restored', 'success');
        }
      };
      showUndoToast('Line deleted');
    });
    chordRow.appendChild(delBtn);
  }

  // Click/tap chord row anywhere to place a chord at that x position
  chordRow.addEventListener('click', e => {
    const rect = chordRow.getBoundingClientRect();
    const x = Math.max(0, Math.round(e.clientX - rect.left));
    if (line.chords.find(c => Math.abs(c.x - x) < 20)) return;
    const chord = { x, name: '' };
    line.chords.push(chord);
    line.chords.sort((a, b) => a.x - b.x);
    saveSingleSong(song);
    renderChordMarkers();
    showChordEdit(song, line, chord);
  });

  // Double-tap chord row to add chord at tap position (mobile-friendly)
  let lastTapTime = 0;
  chordRow.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTapTime < 300) {
      // Double tap - add chord
      const touch = e.changedTouches[0];
      const rect = chordRow.getBoundingClientRect();
      const x = Math.max(0, Math.round(touch.clientX - rect.left));
      if (!line.chords.find(c => Math.abs(c.x - x) < 20)) {
        const chord = { x, name: '' };
        line.chords.push(chord);
        line.chords.sort((a, b) => a.x - b.x);
        saveSingleSong(song);
        renderChordMarkers();
        showChordEdit(song, line, chord);
      }
    }
    lastTapTime = now;
  }, { passive: true });

  lineEl.appendChild(chordRow);
  lineEl.appendChild(lyricInput);

  const addBtn = container.lastElementChild;
  if (addBtn && addBtn.classList.contains('add-line-btn')) container.insertBefore(lineEl, addBtn);
  else container.appendChild(lineEl);
  renderChordMarkers();
}

// Chord Popup — Mobile Bottom Sheet
let chordPopup = null;
function showChordEdit(song, line, chord) {
  if (chordPopup) chordPopup.remove();

  chordPopup = document.createElement('div');
  chordPopup.className = 'chord-popup-sheet';

  // Backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'chord-sheet-backdrop';
  backdrop.addEventListener('click', () => { chordPopup.remove(); chordPopup = null; });

  const sheet = document.createElement('div');
  sheet.className = 'chord-sheet';

  // Handle bar (visual indicator)
  const handle = document.createElement('div');
  handle.className = 'chord-sheet-handle';
  sheet.appendChild(handle);

  // Current chord display
  const chordDisplay = document.createElement('div');
  chordDisplay.className = 'chord-sheet-display';
  chordDisplay.textContent = chord.name || '?';
  sheet.appendChild(chordDisplay);

  // Input
  const input = document.createElement('input');
  input.value = chord.name; input.placeholder = 'Am'; input.spellcheck = false;
  input.className = 'chord-sheet-input';
  sheet.appendChild(input);

  // Recent chords quick-access row
  const recentChords = getRecentChords().filter(c => c !== chord.name);
  if (recentChords.length > 0) {
    const recentRow = document.createElement('div');
    recentRow.className = 'chord-recent-row';
    const recentLabel = document.createElement('div');
    recentLabel.className = 'chord-recent-label';
    recentLabel.textContent = 'Recent';
    recentRow.appendChild(recentLabel);
    const recentPills = document.createElement('div');
    recentPills.className = 'chord-recent-pills';
    recentChords.forEach(rc => {
      const pill = document.createElement('button');
      pill.textContent = rc;
      pill.className = 'chord-recent-pill';
      pill.addEventListener('click', () => {
        input.value = rc;
        chord.name = rc;
        chordDisplay.textContent = rc;
        updateQuickActive();
        updateDiagram(rc);
      });
      recentPills.appendChild(pill);
    });
    recentRow.appendChild(recentPills);
    sheet.appendChild(recentRow);
  }

  // Mini chord diagram preview
  const diagramWrap = document.createElement('div');
  diagramWrap.className = 'chord-sheet-diagram';
  sheet.appendChild(diagramWrap);

  function updateDiagram(chordName) {
    renderMiniFretboard(diagramWrap, chordName || '');
  }
  updateDiagram(chord.name);

  // Chord progression suggestions based on music theory
  function getChordSuggestions(currentChord, songKey) {
    if (!currentChord) return [];
    const root = currentChord.match(/^[A-G][#b]?/)?.[0];
    if (!root) return [];
    const rootIdx = noteToSemitone(root);
    if (rootIdx === -1) return [];

    // Determine the key: use song key if available, otherwise infer from current chord
    let keyIdx = songKey ? noteToSemitone(songKey) : rootIdx;
    if (keyIdx === -1) keyIdx = rootIdx;

    // Diatonic scale degrees (major scale): W W H W W W H
    const majorScale = [0, 2, 4, 5, 7, 9, 11];
    // Diatonic chord qualities in major key: I ii iii IV V vi vii°
    const diatonicQualities = ['', 'm', 'm', '', '', 'm', 'dim'];
    // Build diatonic chords for the key
    const diatonic = majorScale.map((deg, i) => semitoneToNote(keyIdx + deg) + diatonicQualities[i]);

    // Common progression rules (scale degree offsets from current chord)
    // V → I (dominant → tonic), IV → I, ii → V, vi → IV, etc.
    const suggestions = [];
    const seen = new Set();

    // Always include the diatonic chords (most common in the key)
    diatonic.forEach(ch => {
      if (ch !== currentChord && !seen.has(ch)) {
        seen.add(ch);
        suggestions.push(ch);
      }
    });

    // Add relative minor/major relationships
    const relMinor = semitoneToNote(rootIdx + 9) + 'm';  // vi of current
    const relMajor = semitoneToNote(rootIdx - 9);          // bVI (borrowed)
    const dom7 = semitoneToNote(rootIdx + 7) + '7';        // V7
    const subdom = semitoneToNote(rootIdx + 5);            // IV

    [relMinor, dom7, subdom, relMajor].forEach(ch => {
      if (ch !== currentChord && !seen.has(ch)) {
        seen.add(ch);
        suggestions.push(ch);
      }
    });

    return suggestions.slice(0, 6);
  }

  // Chord suggestion pills
  const suggestionChords = getChordSuggestions(chord.name, song?.key);
  if (suggestionChords.length > 0) {
    const suggestRow = document.createElement('div');
    suggestRow.className = 'chord-suggest-row';
    const suggestLabel = document.createElement('div');
    suggestLabel.className = 'chord-suggest-label';
    suggestLabel.textContent = 'Suggestions';
    suggestRow.appendChild(suggestLabel);
    const suggestPills = document.createElement('div');
    suggestPills.className = 'chord-suggest-pills';
    suggestionChords.forEach(sc => {
      const pill = document.createElement('button');
      pill.textContent = sc;
      pill.className = 'chord-suggest-pill';
      pill.addEventListener('click', () => {
        input.value = sc;
        chord.name = sc;
        chordDisplay.textContent = sc;
        updateQuickActive();
        updateDiagram(sc);
      });
      suggestPills.appendChild(pill);
    });
    suggestRow.appendChild(suggestPills);
    sheet.appendChild(suggestRow);
  }

  // Common chord quick-select
  const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const suffixes = ['', 'm', '7', 'm7', 'maj7', 'dim', 'aug', 'sus4', 'add9'];

  const quickRow = document.createElement('div');
  quickRow.className = 'chord-quick';

  // Root note buttons
  const rootRow = document.createElement('div');
  rootRow.className = 'chord-quick-row';
  roots.forEach(r => {
    const btn = document.createElement('button');
    btn.textContent = r;
    btn.className = 'chord-q-btn chord-q-btn-lg' + (chord.name === r ? ' active' : '');
    btn.addEventListener('click', () => {
      input.value = r;
      chord.name = r;
      chordDisplay.textContent = r;
      updateQuickActive();
      updateDiagram(r);
    });
    rootRow.appendChild(btn);
  });
  quickRow.appendChild(rootRow);

  // Suffix buttons
  const suffixRow = document.createElement('div');
  suffixRow.className = 'chord-quick-row';
  const suffixBtns = [];
  suffixes.forEach(s => {
    const root = chord.name?.match(/^[A-G][#b]?/)?.[0] || 'C';
    const full = root + s;
    const btn = document.createElement('button');
    btn.textContent = s || '♮';
    btn.className = 'chord-q-btn chord-q-btn-lg chord-q-small' + (chord.name === full ? ' active' : '');
    btn.addEventListener('click', () => {
      const currentRoot = input.value?.match(/^[A-G][#b]?/)?.[0] || root;
      const newChord = currentRoot + s;
      input.value = newChord;
      chord.name = newChord;
      chordDisplay.textContent = newChord;
      updateQuickActive();
      updateDiagram(newChord);
    });
    suffixBtns.push(btn);
    suffixRow.appendChild(btn);
  });
  quickRow.appendChild(suffixRow);

  function updateQuickActive() {
    rootRow.querySelectorAll('.chord-q-btn').forEach(b => b.classList.toggle('active', b.textContent === input.value));
    suffixBtns.forEach((b, i) => {
      const currentRoot = input.value?.match(/^[A-G][#b]?/)?.[0] || 'C';
      b.classList.toggle('active', input.value === currentRoot + suffixes[i]);
    });
  }

  input.addEventListener('input', () => {
    chord.name = input.value.trim();
    chordDisplay.textContent = chord.name || '?';
    updateQuickActive();
    updateDiagram(input.value);
  });
  sheet.appendChild(quickRow);

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'chord-popup-actions';

  const doneBtn = document.createElement('button');
  doneBtn.className = 'done-btn'; doneBtn.textContent = '✓ Done';
  doneBtn.addEventListener('click', () => {
    chord.name = input.value.trim();
    if (chord.name) addRecentChord(chord.name);
    line.chords.sort((a, b) => a.x - b.x);
    saveSingleSong(song);
    chordPopup.remove(); chordPopup = null;
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn'; removeBtn.textContent = '✕ Remove';
  removeBtn.addEventListener('click', () => {
    line.chords = line.chords.filter(c => c !== chord);
    saveSingleSong(song);
    chordPopup.remove(); chordPopup = null;
  });

  btnRow.appendChild(removeBtn);
  btnRow.appendChild(doneBtn);
  sheet.appendChild(btnRow);

  chordPopup.appendChild(backdrop);
  chordPopup.appendChild(sheet);
  document.body.appendChild(chordPopup);
  enableDragToDismiss(chordPopup, { contentSelector: '.chord-sheet', backdropSelector: '.chord-sheet-backdrop', onDismiss: () => { chordPopup = null; } });

  // Focus input after animation
  setTimeout(() => input.focus(), 100);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doneBtn.click(); });

  // Close on outside click
  const closeOnOutside = e => {
    if (chordPopup && !sheet.contains(e.target) && !backdrop.contains(e.target)) return;
    if (chordPopup && backdrop.contains(e.target)) {
      chordPopup.remove(); chordPopup = null;
      document.removeEventListener('click', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 100);
}

// ===== Chord Diagram Panel =====
// Chord shape definitions: { frets: [eADGBe], fingers: [eADGBe], barres: [{fret, from, to}] }
// frets: -1 = muted, 0 = open, 1-4 = fret number
// fingers: 0 = none, 1-4 = finger number
// Strings indexed 0-5: e(low), A, D, G, B, e(high)
const CHORD_SHAPES = {
  // Major
  'C':  { frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },
  'C#': { frets: [-1, 4, 3, 1, 2, 1], fingers: [0, 4, 3, 1, 2, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Db': { frets: [-1, 4, 3, 1, 2, 1], fingers: [0, 4, 3, 1, 2, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'D':  { frets: [-1, -1, 0, 2, 3, 2], fingers: [0, 0, 0, 1, 3, 2] },
  'D#': { frets: [-1, -1, 1, 3, 4, 3], fingers: [0, 0, 1, 2, 4, 3], barres: [{fret: 3, from: 4, to: 1}] },
  'Eb': { frets: [-1, -1, 1, 3, 4, 3], fingers: [0, 0, 1, 2, 4, 3], barres: [{fret: 3, from: 4, to: 1}] },
  'E':  { frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },
  'F':  { frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'F#': { frets: [2, 4, 4, 3, 2, 2], fingers: [1, 3, 4, 2, 1, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Gb': { frets: [2, 4, 4, 3, 2, 2], fingers: [1, 3, 4, 2, 1, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'G':  { frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },
  'G#': { frets: [4, 3, 1, 1, 1, 4], fingers: [3, 2, 1, 1, 1, 4], barres: [{fret: 1, from: 4, to: 1}] },
  'Ab': { frets: [4, 3, 1, 1, 1, 4], fingers: [3, 2, 1, 1, 1, 4], barres: [{fret: 1, from: 4, to: 1}] },
  'A':  { frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0] },
  'A#': { frets: [-1, 1, 3, 3, 3, 1], fingers: [0, 1, 2, 3, 4, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Bb': { frets: [-1, 1, 3, 3, 3, 1], fingers: [0, 1, 2, 3, 4, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'B':  { frets: [-1, 2, 4, 4, 4, 2], fingers: [0, 1, 2, 3, 4, 1], barres: [{fret: 2, from: 5, to: 1}] },
  // Minor
  'Cm':  { frets: [-1, 3, 1, 0, 1, 3], fingers: [0, 4, 2, 0, 1, 3], barres: [{fret: 3, from: 5, to: 1}] },
  'C#m': { frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Dm':  { frets: [-1, -1, 0, 2, 3, 1], fingers: [0, 0, 0, 2, 3, 1] },
  'D#m': { frets: [-1, -1, 1, 3, 4, 2], fingers: [0, 0, 1, 3, 4, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Em':  { frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
  'Ebm': { frets: [-1, -1, 1, 3, 4, 2], fingers: [0, 0, 1, 3, 4, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Fm':  { frets: [1, 3, 3, 1, 1, 1], fingers: [1, 3, 4, 1, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'F#m': { frets: [2, 4, 4, 2, 2, 2], fingers: [1, 3, 4, 1, 1, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Gm':  { frets: [3, 1, 3, 3, 3, 1], fingers: [2, 1, 3, 3, 3, 1], barres: [{fret: 3, from: 4, to: 1}] },
  'G#m': { frets: [2, 4, 4, 2, 2, 2], fingers: [1, 3, 4, 1, 1, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Am':  { frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0] },
  'A#m': { frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Bbm': { frets: [-1, 1, 3, 3, 2, 1], fingers: [0, 1, 3, 4, 2, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Bm':  { frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Abm': { frets: [2, 4, 4, 2, 2, 2], fingers: [1, 3, 4, 1, 1, 1], barres: [{fret: 2, from: 5, to: 1}] },
  'Dbm': { frets: [-1, 2, 4, 4, 3, 2], fingers: [0, 1, 3, 4, 2, 1], barres: [{fret: 2, from: 5, to: 1}] },
  // 7th
  'C7':  { frets: [-1, 3, 2, 3, 1, 0], fingers: [0, 3, 2, 4, 1, 0] },
  'D7':  { frets: [-1, -1, 0, 2, 1, 2], fingers: [0, 0, 0, 2, 1, 3] },
  'E7':  { frets: [0, 2, 0, 1, 0, 0], fingers: [0, 2, 0, 1, 0, 0] },
  'F7':  { frets: [1, 3, 1, 2, 1, 1], fingers: [1, 3, 1, 2, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'G7':  { frets: [3, 2, 0, 0, 0, 1], fingers: [3, 2, 0, 0, 0, 1] },
  'A7':  { frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 1, 0, 2, 0] },
  'B7':  { frets: [-1, 2, 1, 2, 0, 2], fingers: [0, 2, 1, 3, 0, 4] },
  // major 7th
  'Cmaj7': { frets: [-1, 3, 2, 0, 0, 0], fingers: [0, 3, 2, 0, 0, 0] },
  'Dmaj7': { frets: [-1, -1, 0, 2, 2, 2], fingers: [0, 0, 0, 1, 2, 3] },
  'Emaj7': { frets: [0, 2, 1, 1, 0, 0], fingers: [0, 3, 1, 2, 0, 0] },
  'Fmaj7': { frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Gmaj7': { frets: [3, 2, 0, 0, 0, 2], fingers: [3, 2, 0, 0, 0, 1] },
  'Amaj7': { frets: [-1, 0, 2, 1, 2, 0], fingers: [0, 0, 2, 1, 3, 0] },
  'Bmaj7': { frets: [-1, 2, 4, 3, 4, 2], fingers: [0, 1, 3, 2, 4, 1], barres: [{fret: 2, from: 5, to: 1}] },
  // minor 7th
  'Cm7':  { frets: [-1, 3, 1, 3, 1, 3], fingers: [0, 2, 1, 3, 1, 4], barres: [{fret: 3, from: 5, to: 1}] },
  'Dm7':  { frets: [-1, -1, 0, 2, 1, 1], fingers: [0, 0, 0, 2, 1, 1], barres: [{fret: 1, from: 3, to: 1}] },
  'Em7':  { frets: [0, 2, 0, 0, 0, 0], fingers: [0, 2, 0, 0, 0, 0] },
  'Fm7':  { frets: [1, 3, 1, 1, 1, 1], fingers: [1, 3, 1, 1, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Gm7':  { frets: [3, 5, 3, 3, 3, 3], fingers: [1, 3, 1, 1, 1, 1], barres: [{fret: 3, from: 5, to: 1}] },
  'Am7':  { frets: [-1, 0, 2, 0, 1, 0], fingers: [0, 0, 2, 0, 1, 0] },
  'Bm7':  { frets: [-1, 2, 0, 2, 0, 2], fingers: [0, 2, 0, 3, 0, 4] },
  // dim
  'Cdim': { frets: [-1, 3, 1, 3, 1, -1], fingers: [0, 2, 1, 3, 1, 0] },
  'Ddim': { frets: [-1, -1, 0, 1, 3, 1], fingers: [0, 0, 0, 1, 3, 2] },
  'Edim': { frets: [0, 1, 2, 0, -1, -1], fingers: [0, 1, 2, 0, 0, 0] },
  'Fdim': { frets: [1, 2, 3, 1, -1, -1], fingers: [1, 2, 3, 1, 0, 0] },
  'Gdim': { frets: [3, 1, 3, 1, -1, -1], fingers: [3, 1, 4, 2, 0, 0] },
  'Adim': { frets: [-1, 0, 1, 2, 1, -1], fingers: [0, 0, 1, 3, 2, 0] },
  'Bdim': { frets: [-1, 2, 3, 4, 3, -1], fingers: [0, 1, 2, 4, 3, 0] },
  // aug
  'Caug': { frets: [-1, 3, 2, 1, 1, 0], fingers: [0, 4, 3, 1, 2, 0] },
  'Daug': { frets: [-1, -1, 0, 3, 3, 2], fingers: [0, 0, 0, 2, 3, 1] },
  'Eaug': { frets: [0, 3, 2, 1, 1, 0], fingers: [0, 4, 3, 1, 2, 0] },
  'Faug': { frets: [1, -1, 3, 2, 2, 1], fingers: [1, 0, 4, 2, 3, 1] },
  'Gaug': { frets: [3, -1, 1, 0, 0, 3], fingers: [2, 0, 1, 0, 0, 3] },
  'Aaug': { frets: [-1, 0, 3, 2, 2, 1], fingers: [0, 0, 4, 2, 3, 1] },
  'Baug': { frets: [-1, 2, 1, 0, 0, 3], fingers: [0, 2, 1, 0, 0, 3] },
  // sus4
  'Csus4': { frets: [-1, 3, 3, 0, 1, 1], fingers: [0, 3, 4, 0, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Dsus4': { frets: [-1, -1, 0, 2, 3, 3], fingers: [0, 0, 0, 1, 3, 4] },
  'Esus4': { frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
  'Fsus4': { frets: [1, 3, 3, 3, 1, 1], fingers: [1, 3, 4, 2, 1, 1], barres: [{fret: 1, from: 5, to: 1}] },
  'Gsus4': { frets: [3, 3, 0, 0, 1, 3], fingers: [2, 3, 0, 0, 1, 4] },
  'Asus4': { frets: [-1, 0, 2, 2, 3, 0], fingers: [0, 0, 1, 2, 3, 0] },
  'Bsus4': { frets: [-1, 2, 4, 4, 5, 2], fingers: [0, 1, 2, 3, 4, 1], barres: [{fret: 2, from: 5, to: 1}] },
  // add9
  'Cadd9':  { frets: [-1, 3, 2, 0, 3, 3], fingers: [0, 2, 1, 0, 3, 4] },
  'Dadd9':  { frets: [-1, -1, 0, 2, 3, 0], fingers: [0, 0, 0, 1, 3, 0] },
  'Eadd9':  { frets: [0, 2, 2, 1, 0, 2], fingers: [0, 2, 3, 1, 0, 4] },
  'Fadd9':  { frets: [-1, -1, 3, 2, 1, 3], fingers: [0, 0, 3, 2, 1, 4] },
  'Gadd9':  { frets: [3, -1, 0, 2, 0, 3], fingers: [3, 0, 0, 1, 0, 4] },
  'Aadd9':  { frets: [-1, 0, 2, 4, 2, 0], fingers: [0, 0, 1, 3, 1, 0] },
  'Badd9':  { frets: [-1, 2, 4, 4, 2, 2], fingers: [0, 1, 3, 4, 1, 1] },
};

const ALL_CHORD_NAMES = Object.keys(CHORD_SHAPES).sort();

function getChordShape(chordName) {
  if (CHORD_SHAPES[chordName]) return { ...CHORD_SHAPES[chordName], name: chordName };
  const m = chordName.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return null;
  const root = m[1], suffix = m[2];
  const candidates = Object.keys(CHORD_SHAPES).filter(k => k === root + suffix);
  if (candidates.length) return { ...CHORD_SHAPES[candidates[0]], name: candidates[0] };
  return null;
}

function getStartFret(frets) {
  const played = frets.filter(f => f > 0);
  if (!played.length) return 1;
  const min = Math.min(...played);
  if (min <= 2) return 1;
  return min - 1;
}

// Mini chord diagram for the chord edit popup — compact SVG fretboard
function renderMiniFretboard(container, chordName) {
  const shape = getChordShape(chordName);
  if (!shape) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';

  const frets = shape.frets;
  const fingers = shape.fingers || [0,0,0,0,0,0];
  const barres = shape.barres || [];
  const numStrings = 6;
  const numFrets = 4;
  const startFret = getStartFret(frets);

  const w = 120, h = 148;
  const padX = 18, padY = 20;
  const fretW = w - padX * 2;
  const fretH = h - padY * 2 - 16;
  const stringSpacing = fretW / (numStrings - 1);
  const fretSpacing = fretH / numFrets;
  const dotRadius = 6;

  const minFret = Math.min(...frets.filter(f => f > 0));
  const hasOpen = frets.some(f => f === 0);
  const showNut = hasOpen || minFret <= 2;

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="cd-mini-fretboard" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0" y="0" width="${w}" height="${h}" fill="transparent"/>`;

  if (!showNut && startFret > 1) {
    svg += `<text x="${padX - 8}" y="${padY + fretSpacing * 0.6}" fill="var(--fg-tertiary)" font-size="8" font-family="var(--font)" text-anchor="middle">${startFret}fr</text>`;
  }

  // Strings
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringSpacing;
    const strokeW = 0.8 + s * 0.2;
    svg += `<line x1="${x}" y1="${padY}" x2="${x}" y2="${padY + fretH}" stroke="var(--fg-tertiary)" stroke-width="${strokeW}"/>`;
  }

  // Frets
  for (let f = 0; f <= numFrets; f++) {
    const y = padY + f * fretSpacing;
    const isNut = f === 0 && showNut;
    svg += `<line x1="${padX}" y1="${y}" x2="${padX + fretW}" y2="${y}" stroke="${isNut ? 'var(--fg)' : 'var(--fg-tertiary)'}" stroke-width="${isNut ? 2 : 0.8}"/>`;
  }

  // Finger positions
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringSpacing;
    const fret = frets[s];
    const finger = fingers[s];

    if (fret === -1) {
      const y = padY - 9;
      svg += `<text x="${x}" y="${y}" fill="var(--fg-tertiary)" font-size="9" font-family="var(--font)" text-anchor="middle" font-weight="bold">&#10005;</text>`;
    } else if (fret === 0) {
      const y = padY - 9;
      svg += `<text x="${x}" y="${y}" fill="var(--fg-secondary)" font-size="10" font-family="var(--font)" text-anchor="middle" font-weight="bold">&#9675;</text>`;
    } else {
      const fretPos = fret - startFret + (showNut ? 0 : 1);
      const y = padY + fretPos * fretSpacing + fretSpacing / 2;
      const isBarre = barres.some(b => b.fret === fret && s >= Math.min(b.from, b.to) && s <= Math.max(b.from, b.to));

      if (isBarre) {
        const barreStart = padX + Math.min(barres[0].from, barres[0].to) * stringSpacing;
        const barreEnd = padX + Math.max(barres[0].from, barres[0].to) * stringSpacing;
        svg += `<line x1="${barreStart}" y1="${y}" x2="${barreEnd}" y2="${y}" stroke="var(--chord)" stroke-width="${dotRadius * 1.4}" stroke-linecap="round" opacity="0.85"/>`;
      } else {
        svg += `<circle cx="${x}" cy="${y}" r="${dotRadius}" fill="var(--chord)" opacity="0.9"/>`;
      }
      if (finger > 0) {
        svg += `<text x="${x}" y="${y + 3}" fill="var(--bg)" font-size="7" font-family="var(--font)" text-anchor="middle" font-weight="700">${finger}</text>`;
      }
    }
  }

  // String labels
  const stringLabels = ['E', 'A', 'D', 'G', 'B', 'e'];
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringSpacing;
    svg += `<text x="${x}" y="${h - 4}" fill="var(--fg-tertiary)" font-size="7" font-family="var(--font)" text-anchor="middle">${stringLabels[s]}</text>`;
  }

  svg += '</svg>';
  container.innerHTML = svg;
}

function renderFretboard(container, chordName, capo) {
  const shape = getChordShape(chordName);
  if (!shape) {
    container.innerHTML = `<div class="cd-no-chord">No diagram for "${esc(chordName)}"<br><span style="font-size:13px;color:var(--fg-tertiary);">Try common chords like G, C, D, Am, Em, F...</span></div>`;
    return;
  }

  const frets = shape.frets;
  const fingers = shape.fingers || [0,0,0,0,0,0];
  const barres = shape.barres || [];
  const numStrings = 6;
  const numFrets = 5;
  const startFret = getStartFret(frets);

  const w = 200, h = 260;
  const padX = 30, padY = 30;
  const fretW = w - padX * 2;
  const fretH = h - padY * 2 - 30;
  const stringSpacing = fretW / (numStrings - 1);
  const fretSpacing = fretH / numFrets;
  const dotRadius = 9;

  let svg = `<svg viewBox="0 0 ${w} ${h}" class="cd-fretboard" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect x="0" y="0" width="${w}" height="${h}" fill="transparent"/>`;

  const minFret = Math.min(...frets.filter(f => f > 0));
  const hasOpen = frets.some(f => f === 0);
  const showNut = hasOpen || minFret <= 2;

  // Capo indicator: draw a thick horizontal bar across all strings at the capo fret
  // The capo sits *above* the first displayed fret, so we show it at the nut position
  // or between frets if capo >= startFret
  const showCapo = capo && capo > 0;
  let capoY = null;
  if (showCapo) {
    if (capo < startFret) {
      // Capo is below the first displayed fret — show at nut position
      capoY = padY;
    } else {
      // Capo is within the displayed range
      const capoFretPos = capo - startFret + (showNut ? 0 : 1);
      capoY = padY + capoFretPos * fretSpacing + fretSpacing / 2;
    }
    // Draw capo bar
    if (capoY !== null) {
      svg += `<rect x="${padX - 2}" y="${capoY - 5}" width="${fretW + 4}" height="10" rx="5" fill="var(--accent)" opacity="0.85"/>`;
      svg += `<text x="${padX - 14}" y="${capoY + 4}" fill="var(--accent)" font-size="10" font-family="var(--font)" text-anchor="middle" font-weight="700">C${capo}</text>`;
    }
  }

  if (!showNut && startFret > 1) {
    svg += `<text x="${padX - 12}" y="${padY + fretSpacing * 0.7}" fill="var(--fg-tertiary)" font-size="12" font-family="var(--font)" text-anchor="middle">${startFret}fr</text>`;
  }

  // Strings
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringSpacing;
    const strokeW = 1 + s * 0.3;
    svg += `<line x1="${x}" y1="${padY}" x2="${x}" y2="${padY + fretH}" stroke="var(--fg-tertiary)" stroke-width="${strokeW}"/>`;
  }

  // Frets
  for (let f = 0; f <= numFrets; f++) {
    const y = padY + f * fretSpacing;
    const isNut = f === 0 && showNut;
    svg += `<line x1="${padX}" y1="${y}" x2="${padX + fretW}" y2="${y}" stroke="${isNut ? 'var(--fg)' : 'var(--fg-tertiary)'}" stroke-width="${isNut ? 3 : 1}"/>`;
  }

  // Finger positions
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringSpacing;
    const fret = frets[s];
    const finger = fingers[s];

    if (fret === -1) {
      const y = padY - 14;
      svg += `<text x="${x}" y="${y}" fill="var(--fg-tertiary)" font-size="14" font-family="var(--font)" text-anchor="middle" font-weight="bold">&#10005;</text>`;
    } else if (fret === 0) {
      // Open string — only show if no capo, or if capo doesn't cover this string
      if (!showCapo || capo < startFret) {
        const y = padY - 14;
        svg += `<text x="${x}" y="${y}" fill="var(--fg-secondary)" font-size="14" font-family="var(--font)" text-anchor="middle" font-weight="bold">&#9675;</text>`;
      } else {
        // Capo covers this open string — show muted
        const y = padY - 14;
        svg += `<text x="${x}" y="${y}" fill="var(--fg-tertiary)" font-size="14" font-family="var(--font)" text-anchor="middle" font-weight="bold">&#10005;</text>`;
      }
    } else {
      const fretPos = fret - startFret + (showNut ? 0 : 1);
      const y = padY + fretPos * fretSpacing + fretSpacing / 2;
      const isBarre = barres.some(b => b.fret === fret && s >= Math.min(b.from, b.to) && s <= Math.max(b.from, b.to));

      if (isBarre) {
        const barreStart = padX + Math.min(barres[0].from, barres[0].to) * stringSpacing;
        const barreEnd = padX + Math.max(barres[0].from, barres[0].to) * stringSpacing;
        svg += `<line x1="${barreStart}" y1="${y}" x2="${barreEnd}" y2="${y}" stroke="var(--chord)" stroke-width="${dotRadius * 1.6}" stroke-linecap="round" opacity="0.85"/>`;
      } else {
        svg += `<circle cx="${x}" cy="${y}" r="${dotRadius}" fill="var(--chord)" opacity="0.9"/>`;
      }
      if (finger > 0) {
        svg += `<text x="${x}" y="${y + 4}" fill="var(--bg)" font-size="10" font-family="var(--font)" text-anchor="middle" font-weight="700">${finger}</text>`;
      }
    }
  }

  // String labels
  const stringLabels = ['E', 'A', 'D', 'G', 'B', 'e'];
  for (let s = 0; s < numStrings; s++) {
    const x = padX + s * stringSpacing;
    svg += `<text x="${x}" y="${h - 6}" fill="var(--fg-tertiary)" font-size="10" font-family="var(--font)" text-anchor="middle">${stringLabels[s]}</text>`;
  }

  svg += '</svg>';
  container.innerHTML = svg;
}

// Extract unique chords from a song in order of first appearance
function getSongUniqueChords(song) {
  const seen = new Set();
  const result = [];
  if (!song || !song.sections) return result;
  for (const sec of song.sections) {
    for (const line of (sec.lines || [])) {
      for (const c of (line.chords || [])) {
        if (c.name && c.name.trim()) {
          const n = c.name.trim();
          if (!seen.has(n)) { seen.add(n); result.push(n); }
        }
      }
    }
  }
  return result;
}

function showChordDiagramPanel(initialChord) {
  // Get current song's capo and unique chords
  const currentSong = getSong(currentSongId);
  const capo = currentSong?.capo || 0;
  const songChords = getSongUniqueChords(currentSong);

  let panel = $('chord-diagram-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'chord-diagram-panel';
    panel.innerHTML = `<div class="toolbar-sheet-backdrop"></div>`;
    const content = document.createElement('div');
    content.className = 'cd-panel-content';
    content.innerHTML = `
      <div class="toolbar-sheet-handle"></div>
      <div class="cd-header">
        <h3 class="cd-title">Chord Diagram</h3>
        <div class="cd-chord-name" id="cd-chord-name">C</div>
        <div class="cd-chord-counter" id="cd-chord-counter"></div>
        <div class="cd-capo-label" id="cd-capo-label" style="display:none;"></div>
      </div>
      <div class="cd-fretboard-wrap" id="cd-fretboard-wrap"></div>
      <div class="cd-swipe-hint" id="cd-swipe-hint">‹ swipe ›</div>
      <div class="cd-controls">
        <div class="cd-chord-nav">
          <button class="cd-nav-btn" id="cd-prev" title="Previous chord">‹</button>
          <button class="cd-nav-btn" id="cd-next" title="Next chord">›</button>
        </div>
        <div class="cd-chord-input-wrap">
          <input type="text" id="cd-chord-input" class="cd-chord-input" placeholder="Chord name" spellcheck="false">
          <button id="cd-lookup-btn" class="cd-lookup-btn">Go</button>
        </div>
      </div>
      <div class="cd-browse">
        <div class="cd-browse-label">Common Chords</div>
        <div class="cd-browse-grid" id="cd-browse-grid"></div>
      </div>
    `;
    panel.appendChild(content);
    document.body.appendChild(panel);

    panel.querySelector('.toolbar-sheet-backdrop').addEventListener('click', () => {
      panel.style.display = 'none';
    });

    // --- Swipe on fretboard to cycle song chords ---
    const fretWrap = $('cd-fretboard-wrap');
    let touchStartX = 0, touchStartY = 0, touchMoved = false;
    const SWIPE_THRESHOLD = 40;
    fretWrap.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchMoved = false;
    }, { passive: true });
    fretWrap.addEventListener('touchmove', e => {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 10 || dy > 10) touchMoved = true;
    }, { passive: true });
    fretWrap.addEventListener('touchend', e => {
      if (!touchMoved) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) > dy * 1.5) return;
      // Use song chords if available, otherwise fall back to ALL_CHORD_NAMES
      const list = songChords.length >= 2 ? songChords : null;
      if (!list) return;
      const curName = $('cd-chord-name').textContent;
      let idx = list.indexOf(curName);
      if (idx === -1) idx = 0;
      if (dx < 0) {
        // swipe left → next
        const next = list[(idx + 1) % list.length];
        setDiagramChord(next, capo);
        animateFretSwipe('left');
      } else {
        // swipe right → prev
        const prev = list[(idx - 1 + list.length) % list.length];
        setDiagramChord(prev, capo);
        animateFretSwipe('right');
      }
    }, { passive: true });

    const doSet = (name) => setDiagramChord(name, capo);

    $('cd-prev').addEventListener('click', () => {
      const name = $('cd-chord-name').textContent;
      // Prefer song chord list for navigation
      if (songChords.length >= 2) {
        let idx = songChords.indexOf(name);
        if (idx === -1) idx = 0;
        doSet(songChords[(idx - 1 + songChords.length) % songChords.length]);
      } else {
        const idx = ALL_CHORD_NAMES.indexOf(name);
        const prev = idx > 0 ? ALL_CHORD_NAMES[idx - 1] : ALL_CHORD_NAMES[ALL_CHORD_NAMES.length - 1];
        doSet(prev);
      }
    });
    $('cd-next').addEventListener('click', () => {
      const name = $('cd-chord-name').textContent;
      if (songChords.length >= 2) {
        let idx = songChords.indexOf(name);
        if (idx === -1) idx = 0;
        doSet(songChords[(idx + 1) % songChords.length]);
      } else {
        const idx = ALL_CHORD_NAMES.indexOf(name);
        const next = idx < ALL_CHORD_NAMES.length - 1 ? ALL_CHORD_NAMES[idx + 1] : ALL_CHORD_NAMES[0];
        doSet(next);
      }
    });

    $('cd-lookup-btn').addEventListener('click', () => {
      const val = $('cd-chord-input').value.trim();
      if (val) doSet(val);
    });
    $('cd-chord-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('cd-lookup-btn').click();
    });

    const grid = $('cd-browse-grid');
    const commonChords = ['C','D','E','F','G','A','B','Am','Bm','Cm','Dm','Em','Fm','Gm','C7','D7','E7','G7','A7','B7','Cmaj7','Dmaj7','Fmaj7','Gmaj7','Amaj7','Em7','Am7','Bm7','Dm7','Fdim','Gdim','Adim','Bdim','Caug','Daug','Eaug','Aaug','Dsus4','Esus4','Gsus4','Asus4','Cadd9','Dadd9','Eadd9','Gadd9','Aadd9'];
    grid.innerHTML = commonChords.map(ch => `<button class="cd-browse-btn" data-chord="${ch}">${ch}</button>`).join('');
    grid.querySelectorAll('.cd-browse-btn').forEach(btn => {
      btn.addEventListener('click', () => doSet(btn.dataset.chord));
    });
  }

  panel.style.display = 'flex';
  // Update capo label visibility
  const capoLabel = $('cd-capo-label');
  if (capoLabel) {
    if (capo > 0) {
      // Compute real chord name
      const realChord = initialChord ? transposeChord(initialChord, capo) : '';
      capoLabel.textContent = `Capo ${capo} — sounds as ${realChord}`;
      capoLabel.style.display = 'block';
    } else {
      capoLabel.style.display = 'none';
    }
  }
  // Update song chords list on the panel instance so swipe always uses latest
  panel._songChords = songChords;
  setDiagramChord(initialChord || 'C', capo);
  updateChordCounter(initialChord || 'C', songChords);
}

function animateFretSwipe(direction) {
  const wrap = $('cd-fretboard-wrap');
  if (!wrap) return;
  const offset = direction === 'left' ? -30 : 30;
  wrap.style.transition = 'none';
  wrap.style.transform = `translateX(${offset}px)`;
  // force reflow
  void wrap.offsetWidth;
  wrap.style.transition = 'transform 0.2s ease';
  wrap.style.transform = 'translateX(0)';
  setTimeout(() => { wrap.style.transition = ''; wrap.style.transform = ''; }, 250);
}

function updateChordCounter(name, songChords) {
  const counter = $('cd-chord-counter');
  if (!counter) return;
  if (songChords.length >= 2) {
    let idx = songChords.indexOf(name);
    if (idx === -1) idx = 0;
    counter.textContent = `${idx + 1} / ${songChords.length}`;
    counter.style.display = 'block';
  } else {
    counter.style.display = 'none';
  }
}

function setDiagramChord(name, capo) {
  const nameEl = $('cd-chord-name');
  const inputEl = $('cd-chord-input');
  const wrap = $('cd-fretboard-wrap');
  const capoLabel = $('cd-capo-label');
  if (nameEl) nameEl.textContent = name;
  if (inputEl) inputEl.value = name;
  if (wrap) renderFretboard(wrap, name, capo);
  if (capoLabel && capo > 0) {
    const realChord = transposeChord(name, capo);
    capoLabel.textContent = `Capo ${capo} — sounds as ${realChord}`;
    capoLabel.style.display = 'block';
  } else if (capoLabel) {
    capoLabel.style.display = 'none';
  }
  document.querySelectorAll('.cd-browse-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.chord === name);
  });
  // Update chord counter from panel's song chords
  const panel = $('chord-diagram-panel');
  if (panel && panel._songChords) {
    updateChordCounter(name, panel._songChords);
  }
}

// ===== Mobile Keyboard Handling =====
function initMobileKeyboard() {
  // Track keyboard visibility
  let keyboardVisible = false;
  let keyboardHeight = 0;

  // Method 1: VisualViewport API (modern browsers)
  if (window.visualViewport) {
    const vv = window.visualViewport;
    vv.addEventListener('resize', () => {
      const windowHeight = window.innerHeight;
      const viewportHeight = vv.height;
      keyboardVisible = viewportHeight < windowHeight - 50;
      keyboardHeight = keyboardVisible ? windowHeight - viewportHeight : 0;

      const toolbar = $('mobile-toolbar');
      const fab = $('toolbar-fab');
      const sheet = $('toolbar-sheet');

      if (keyboardVisible) {
        document.body.classList.add('keyboard-open');
        if (toolbar) toolbar.style.transform = `translateY(${keyboardHeight}px)`;
        if (fab) fab.style.transform = `translateY(${keyboardHeight}px)`;
        if (sheet) sheet.style.transform = `translateY(${keyboardHeight}px)`;
      } else {
        document.body.classList.remove('keyboard-open');
        if (toolbar) toolbar.style.transform = '';
        if (fab) fab.style.transform = '';
        if (sheet) sheet.style.transform = '';
      }
    });
  }

  // Method 2: Focus-based detection (fallback)
  const focusableSelector = 'input, textarea, [contenteditable="true"]';

  document.addEventListener('focusin', e => {
    if (e.target.matches(focusableSelector)) {
      setTimeout(() => {
        const el = e.target;
        const rect = el.getBoundingClientRect();
        const toolbarHeight = 60;
        const bottomEdge = rect.bottom + toolbarHeight;

        if (bottomEdge > window.innerHeight * 0.6) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        const lineEl = el.closest('.chord-line');
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300);
    }
  });

  // Typewriter scroll: keep the active lyric line centered while typing
  let typewriterScrollTimer = null;
  document.addEventListener('input', e => {
    if (!typewriterScroll) return;
    if (!e.target.matches('.lyric-text[contenteditable="true"]')) return;
    // Debounce to avoid jank during fast typing
    if (typewriterScrollTimer) clearTimeout(typewriterScrollTimer);
    typewriterScrollTimer = setTimeout(() => {
      const lineEl = e.target.closest('.chord-line');
      if (!lineEl) return;
      const body = $('song-body');
      if (!body) return;
      const bodyRect = body.getBoundingClientRect();
      const lineRect = lineEl.getBoundingClientRect();
      // Center the line within the song-body scroll container
      const targetScroll = body.scrollTop + (lineRect.top - bodyRect.top) - (bodyRect.height / 2) + (lineRect.height / 2);
      body.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
    }, 120);
  }, { passive: true });

  // Prevent zoom on double-tap for inputs
  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) {
      if (e.target.matches(focusableSelector)) {
        e.preventDefault();
      }
    }
    lastTouchEnd = now;
  }, { passive: false });

  // Handle orientation change
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      const toolbar = $('mobile-toolbar');
      if (toolbar && keyboardVisible) {
        toolbar.style.transform = `translateY(${keyboardHeight}px)`;
      }
    }, 300);
  });

  // iOS-specific: handle form assistant bar
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    document.body.classList.add('ios-device');
  }
}

// Export
function buildExportText(song) {
  let text = `${song.title}\n${'='.repeat(song.title.length)}\n\n`;
  if (song.key) text += `Key: ${song.key}\n`;
  if (song.bpm) text += `BPM: ${song.bpm}\n`;
  if (song.time_sig) text += `Time: ${song.time_sig}\n`;
  if (song.key || song.bpm || song.time_sig) text += '\n';
  if (song.notes) text += `Notes:\n${song.notes}\n\n`;
  song.sections.forEach(section => {
    text += `[${section.type}]\n`;
    if (section.strumming) text += `♫ ${section.strumming}\n`;
    section.lines.forEach(line => {
      if (line.chords.length) {
        let cl = '', lx = 0;
        line.chords.forEach(ch => { const sp = Math.max(0, Math.floor((ch.x - lx) / 7)); cl += ' '.repeat(sp) + ch.name; lx = ch.x + ch.name.length * 7; });
        if (cl.trim()) text += cl + '\n';
      }
      text += line.text + '\n';
    });
    text += '\n';
  });
  return text;
}

function buildExportMarkdown(song) {
  let md = `# ${song.title}\n\n`;
  if (song.key) md += `_Key: ${song.key}_\n`;
  if (song.bpm) md += `_BPM: ${song.bpm}_\n`;
  if (song.time_sig) md += `_Time: ${song.time_sig}_\n`;
  if (song.key || song.bpm || song.time_sig) md += '\n';
  if (song.notes) md += `> **Notes:** ${song.notes}\n\n`;
  song.sections.forEach(section => {
    md += `## ${section.type}\n\n`;
    if (section.strumming) md += `> ♫ ${section.strumming}\n\n`;
    section.lines.forEach(line => {
      const cs = line.chords.sort((a,b) => a.x-b.x).map(c => c.name).join(' ');
      if (cs) md += `  ${cs}  \n`;
      md += line.text + '\n\n';
    });
  });
  return md;
}

function buildExportChordPro(song) {
  // Build valid ChordPro v6 format
  let out = '';
  out += `{title: ${song.title || 'Untitled'}}`;
  if (song.key) out += `\n{key: ${song.key}}`;
  if (song.bpm) out += `\n{tempo: ${song.bpm}}`;
  if (song.time_sig) out += `\n{time: ${song.time_sig}}`;
  if (song.notes) out += `\n{comment: ${song.notes}}`;
  out += '\n';

  const sectionTypeMap = {
    'Chorus': 'chorus', 'Bridge': 'bridge', 'Verse': 'verse',
    'Intro': 'intro', 'Outro': 'outro', 'Hook': 'hook',
    'Refrain': 'refrain', 'Pre-Chorus': 'pre-chorus',
    'Interlude': 'interlude', 'Solo': 'solo', 'Instrumental': 'instrumental',
    'Tag': 'tag', 'Coda': 'coda',
  };

  song.sections.forEach(section => {
    const baseType = section.type.replace(/\s+\d+$/, '');
    const sectionDirective = sectionTypeMap[baseType] || baseType.toLowerCase();
    out += `\n{start_of_${sectionDirective}}\n`;
    if (section.strumming) out += `{comment: ♫ ${section.strumming}}\n`;

    section.lines.forEach(line => {
      if (line.chords && line.chords.length) {
        // Build chord line with proper spacing using pixel positions
        const sorted = [...line.chords].sort((a, b) => a.x - b.x);
        let chordLine = '';
        let pos = 0;
        sorted.forEach(ch => {
          const col = Math.max(0, Math.floor(ch.x / 7));
          while (pos < col) { chordLine += ' '; pos++; }
          chordLine += `[${ch.name}]`;
          pos += ch.name.length + 2; // +2 for [ and ]
        });
        out += chordLine + '\n';
      }
      out += (line.text || '') + '\n';
    });

    out += `{end_of_${sectionDirective}}\n`;
  });

  return out;
}

function downloadFile(content, name, mime) {
  const blob = new Blob([content], { type: mime }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

// ===== Share / Collaborative Editing =====

// Encode a song to a compact share code (base64url JSON)
function encodeSongToShareCode(song) {
  // Strip audio data to keep share codes small — audio doesn't need to be shared
  const shareData = {
    v: 1, // version
    t: song.title || 'Untitled',
    k: song.key || '',
    b: song.bpm || null,
    n: song.notes || '',
    s: (song.sections || []).map(sec => ({
      y: sec.type,
      u: sec.strumming || undefined,
      l: (sec.lines || []).map(ln => ({
        x: ln.text || '',
        c: (ln.chords || []).map(c => ({ p: c.x, n: c.name }))
      }))
    }))
  };
  const json = JSON.stringify(shareData);
  // Use base64url encoding (URL-safe)
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return 'SN:' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Decode a share code back to a song object (returns a new song with generated id)
function decodeShareCodeToSong(code) {
  if (!code || !code.startsWith('SN:')) return null;
  try {
    let base64 = code.slice(3).replace(/-/g, '+').replace(/_/g, '/');
    // Pad base64
    while (base64.length % 4) base64 += '=';
    const json = decodeURIComponent(escape(atob(base64)));
    const d = JSON.parse(json);
    if (!d || d.v !== 1) return null;
    const id = generateId();
    const sections = (d.s || []).map(sec => ({
      type: sec.y || 'Verse',
      strumming: sec.u || null,
      lines: (sec.l || []).map(ln => ({
        text: ln.x || '',
        chords: (ln.c || []).map(c => ({ x: c.p || 0, name: c.n || '' }))
      }))
    }));
    if (!sections.length) sections.push({ type: 'Verse', lines: [{ text: '', chords: [] }] });
    return {
      id,
      title: d.t || 'Shared Song',
      key: d.k || '',
      bpm: d.b || null,
      time_sig: null,
      tags: [],
      folder: null,
      sections,
      audio: [],
      notes: d.n || '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}

// Show the share sheet for the current song
function showShareSheet() {
  const song = getSong(currentSongId);
  if (!song) { toast('No song to share'); return; }

  let sheet = $('share-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'share-sheet';
    sheet.innerHTML = `
      <div class="toolbar-sheet-backdrop"></div>
      <div class="toolbar-sheet-content">
        <div class="toolbar-sheet-handle"></div>
        <h3 class="share-title">Share Song</h3>
        <div class="share-song-title" id="share-song-title"></div>
        <div class="share-options">
          <button class="share-opt-btn" id="share-native-btn">
            <span class="share-opt-icon">↗</span>
            <span class="share-opt-label">Share via…</span>
            <span class="share-opt-desc">Native share on device</span>
          </button>
          <button class="share-opt-btn" id="share-clip-btn">
            <span class="share-opt-icon">⎘</span>
            <span class="share-opt-label">Copy to Clipboard</span>
            <span class="share-opt-desc">Share code for pasting</span>
          </button>
          <button class="share-opt-btn" id="share-qr-btn">
            <span class="share-opt-icon">▣</span>
            <span class="share-opt-label">Show QR Code</span>
            <span class="share-opt-desc">Scan to import on another device</span>
          </button>
        </div>
        <div class="share-code-section">
          <div class="share-code-label">Share Code</div>
          <div class="share-code-wrap">
            <textarea class="share-code-area" id="share-code-area" readonly></textarea>
            <button class="share-copy-code-btn" id="share-copy-code-btn">Copy</button>
          </div>
        </div>
        <div class="share-divider"><span>or import a shared song</span></div>
        <div class="share-import">
          <textarea class="share-import-area" id="share-import-area" placeholder="Paste a share code here…" spellcheck="false"></textarea>
          <button class="share-import-btn" id="share-import-btn">Import Shared Song</button>
        </div>
      </div>`;
    document.body.appendChild(sheet);

    sheet.querySelector('.toolbar-sheet-backdrop').addEventListener('click', () => {
      sheet.style.display = 'none';
    });
  }

  // Populate song info
  $('share-song-title').textContent = song.title || 'Untitled';

  // Generate share code
  const code = encodeSongToShareCode(song);
  const codeArea = $('share-code-area');
  codeArea.value = code;

  // Native share
  const nativeBtn = $('share-native-btn');
  nativeBtn.onclick = async () => {
    const shareText = buildExportText(song);
    const shareData = { title: song.title || 'Song', text: shareText };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        sheet.style.display = 'none';
        return;
      } catch (e) {
        // User cancelled or not supported — fall through to clipboard
      }
    }
    // Fallback: copy share code
    navigator.clipboard.writeText(code).then(() => {
      toast('Share code copied');
      sheet.style.display = 'none';
    }).catch(() => {
      toast('Unable to copy — select and copy manually', 'error');
    });
  };

  // Copy to clipboard
  $('share-clip-btn').onclick = () => {
    navigator.clipboard.writeText(code).then(() => {
      toast('Share code copied to clipboard');
      sheet.style.display = 'none';
    }).catch(() => {
      toast('Unable to copy to clipboard', 'error');
    });
  };

  // Copy code button in the code area
  $('share-copy-code-btn').onclick = () => {
    navigator.clipboard.writeText(code).then(() => toast('Copied')).catch(() => toast('Unable to copy', 'error'));
  };

  // QR Code (simple: show the code in a large monospace display for scanning apps)
  $('share-qr-btn').onclick = () => {
    // For now, show a modal with the share code in large text
    // (Full QR generation would need a library — we use a text-based approach)
    const modal = document.createElement('div');
    modal.className = 'share-qr-modal';
    modal.innerHTML = `
      <div class="share-qr-backdrop"></div>
      <div class="share-qr-content">
        <div class="share-qr-title">Share Code</div>
        <div class="share-qr-code">${esc(code)}</div>
        <div class="share-qr-hint">Copy this code and paste it in another device</div>
        <button class="share-qr-close">Done</button>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.share-qr-backdrop').onclick = () => modal.remove();
    modal.querySelector('.share-qr-close').onclick = () => modal.remove();
  };

  // Import shared song
  $('share-import-btn').onclick = async () => {
    const raw = $('share-import-area').value.trim();
    if (!raw) { toast('Paste a share code first'); return; }
    // Handle both raw code and SN: prefixed
    const code2 = raw.startsWith('SN:') ? raw : 'SN:' + raw;
    const imported = decodeShareCodeToSong(code2);
    if (!imported) { toast('Invalid share code'); return; }
    if (isDuplicateTitle(imported.title)) {
      toast(`"${imported.title}" already exists — rename it first`, 'error');
      return;
    }
    songs.unshift(imported);
    await saveSongs();
    renderSongList();
    sheet.style.display = 'none';
    toast(`Imported "${imported.title}"`);
  };

  sheet.style.display = 'flex';
}

// ===== Plugin System for Custom Export Formats =====

// Plugin registry — each plugin: { id, name, ext, mime, template, enabled }
// Template syntax: {{title}}, {{key}}, {{bpm}}, {{sections}}, {{chords}}, {{text}}
// For sections: use {{#sections}}...{{/sections}} with {{type}}, {{lines}}
// For lines: use {{#lines}}...{{/lines}} with {{text}}, {{chords}}
// For chords: {{#chords}}...{{/chords}} with {{name}}

const DEFAULT_PLUGINS = [
  {
    id: 'builtin-txt',
    name: 'Plain Text',
    ext: 'txt',
    mime: 'text/plain',
    enabled: true,
    builtin: true,
    template: `{{title}}{{#key}} [Key: {{key}}]{{/key}}\n\n{{#sections}}[{{type}}]\n{{#lines}}{{#chords}}{{name}} {{/chords}}{{text}}\n{{/lines}}\n{{/sections}}`
  },
  {
    id: 'builtin-md',
    name: 'Markdown',
    ext: 'md',
    mime: 'text/markdown',
    enabled: true,
    builtin: true,
    template: `# {{title}}{{#key}}\n_Key: {{key}}_{{/key}}\n\n{{#sections}}## {{type}}\n\n{{#lines}}{{#chords}}  {{name}}  \n{{/chords}}{{text}}\n\n{{/lines}}{{/sections}}`
  },
  {
    id: 'builtin-chordpro',
    name: 'ChordPro',
    ext: 'cho',
    mime: 'text/plain',
    enabled: true,
    builtin: true,
    template: `{{chordpro}}`
  },
  {
    id: 'builtin-json',
    name: 'JSON',
    ext: 'json',
    mime: 'application/json',
    enabled: true,
    builtin: true,
    template: `{{json}}`
  },
  {
    id: 'builtin-html',
    name: 'HTML Page',
    ext: 'html',
    mime: 'text/html',
    enabled: false,
    builtin: true,
    template: `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{{title}}</title>
<style>body{font-family:system-ui;max-width:700px;margin:40px auto;padding:0 20px}
h1{font-size:28px;margin-bottom:4px}.key{color:#666;font-size:14px;margin-bottom:24px}
h2{font-size:18px;color:#333;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:24px}
.line{margin:6px 0}.chords{font-weight:700;color:#444;font-size:14px;letter-spacing:1px}
.lyrics{font-size:16px;line-height:1.6}</style></head>
<body><h1>{{title}}</h1>{{#key}}<div class="key">Key: {{key}}</div>{{/key}}
{{#sections}}<h2>{{type}}</h2>{{#lines}}<div class="line">{{#chords}}<div class="chords">{{name}}</div>{{/chords}}<div class="lyrics">{{text}}</div></div>{{/lines}}{{/sections}}
</body></html>`
  }
];

function getPlugins() {
  try {
    const stored = localStorage.getItem('sn_export_plugins');
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge: keep builtins, add user plugins
      const builtinIds = DEFAULT_PLUGINS.map(p => p.id);
      const userPlugins = parsed.filter(p => !builtinIds.includes(p.id));
      return [...DEFAULT_PLUGINS, ...userPlugins];
    }
  } catch (e) {}
  return [...DEFAULT_PLUGINS];
}

function savePlugins(plugins) {
  try {
    safeStorageSet('sn_export_plugins', JSON.stringify(plugins));
  } catch (e) {}
}

// Simple template engine
function renderPluginTemplate(template, song) {
  // Special: {{json}} outputs the whole song as JSON
  if (template.includes('{{json}}')) {
    return template.replace('{{json}}', JSON.stringify(song, null, 2));
  }

  // Special: {{chordpro}} outputs valid ChordPro v6 format
  if (template.includes('{{chordpro}}')) {
    return template.replace('{{chordpro}}', buildExportChordPro(song));
  }

  let result = template;

  // Simple replacements (no conditionals first)
  result = result.replace(/\{\{title\}\}/g, song.title || 'Untitled');
  result = result.replace(/\{\{bpm\}\}/g, song.bpm || '');

  // Conditional blocks: {{#key}}...{{/key}}
  result = result.replace(/\{\{#key\}\}([\s\S]*?)\{\{\/key\}\}/g, song.key ? '$1' : '');
  result = result.replace(/\{\{key\}\}/g, song.key || '');

  // Sections loop
  result = result.replace(/\{\{#sections\}\}([\s\S]*?)\{\{\/sections\}\}/g, (match, sectionTpl) => {
    if (!song.sections || !song.sections.length) return '';
    return song.sections.map(section => {
      let secResult = sectionTpl;
      secResult = secResult.replace(/\{\{#type\}\}([\s\S]*?)\{\{\/type\}\}/g, section.type || 'Verse');
      secResult = secResult.replace(/\{\{type\}\}/g, section.type || 'Verse');

      // Lines loop
      secResult = secResult.replace(/\{\{#lines\}\}([\s\S]*?)\{\{\/lines\}\}/g, (lMatch, lineTpl) => {
        if (!section.lines || !section.lines.length) return '';
        return section.lines.map(line => {
          let lineResult = lineTpl;
          lineResult = lineResult.replace(/\{\{text\}\}/g, line.text || '');

          // Chords
          const chordStr = (line.chords || []).sort((a, b) => a.x - b.x).map(c => c.name).join(' ');
          lineResult = lineResult.replace(/\{\{#chords\}\}([\s\S]*?)\{\{\/chords\}\}/g, chordStr ? '$1' : '');
          lineResult = lineResult.replace(/\{\{chords\}\}/g, chordStr);
          lineResult = lineResult.replace(/\{\{name\}\}/g, chordStr);

          return lineResult;
        }).join('\n');
      });

      return secResult;
    }).join('\n\n');
  });

  return result;
}

function exportWithPlugin(song, plugin) {
  const content = renderPluginTemplate(plugin.template, song);
  downloadFile(content, `${song.title || 'song'}.${plugin.ext}`, plugin.mime);
}

// Show plugin management sheet
function showPluginSheet() {
  let sheet = $('plugin-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'plugin-sheet';
    sheet.innerHTML = `
      <div class="toolbar-sheet-backdrop"></div>
      <div class="toolbar-sheet-content" style="max-height:85vh;">
        <div class="toolbar-sheet-handle"></div>
        <div class="plugin-header">
          <h3 class="plugin-title">Export Plugins</h3>
          <button class="plugin-add-btn" id="plugin-add-btn" title="Add custom plugin">+ New</button>
        </div>
        <div class="plugin-list" id="plugin-list"></div>
        <div class="plugin-editor" id="plugin-editor" style="display:none;">
          <div class="plugin-editor-header">
            <input type="text" class="plugin-editor-name" id="plugin-editor-name" placeholder="Plugin name">
            <div class="plugin-editor-meta">
              <input type="text" class="plugin-editor-ext" id="plugin-editor-ext" placeholder="ext" style="width:60px;">
              <input type="text" class="plugin-editor-mime" id="plugin-editor-mime" placeholder="mime type" style="flex:1;">
            </div>
          </div>
          <textarea class="plugin-editor-tpl" id="plugin-editor-tpl" placeholder="Template…" spellcheck="false"></textarea>
          <div class="plugin-editor-help">
            Variables: {{title}} {{key}} {{bpm}} {{type}} {{text}} {{name}} {{json}}
            Blocks: {{#sections}} {{#lines}} {{#chords}} {{#key}} ... {{/...}}
          </div>
          <div class="plugin-editor-actions">
            <button class="plugin-editor-test" id="plugin-editor-test">Test</button>
            <button class="plugin-editor-save" id="plugin-editor-save">Save</button>
            <button class="plugin-editor-cancel" id="plugin-editor-cancel">Cancel</button>
          </div>
          <div class="plugin-test-output" id="plugin-test-output" style="display:none;"></div>
        </div>
      </div>`;
    document.body.appendChild(sheet);

    sheet.querySelector('.toolbar-sheet-backdrop').addEventListener('click', () => {
      sheet.style.display = 'none';
    });
  }

  renderPluginList();

  $('plugin-add-btn').onclick = () => {
    $('plugin-editor').style.display = 'flex';
    $('plugin-editor-name').value = '';
    $('plugin-editor-ext').value = 'txt';
    $('plugin-editor-mime').value = 'text/plain';
    $('plugin-editor-tpl').value = `{{title}}{{#key}} [Key: {{key}}]{{/key}}\n\n{{#sections}}[{{type}}]\n{{#lines}}{{#chords}}{{name}} {{/chords}}{{text}}\n{{/lines}}\n{{/sections}}`;
    $('plugin-test-output').style.display = 'none';
    editingPluginId = null;
  };

  $('plugin-editor-cancel').onclick = () => {
    $('plugin-editor').style.display = 'none';
  };

  $('plugin-editor-save').onclick = () => {
    const name = $('plugin-editor-name').value.trim();
    const ext = $('plugin-editor-ext').value.trim() || 'txt';
    const mime = $('plugin-editor-mime').value.trim() || 'text/plain';
    const tpl = $('plugin-editor-tpl').value;
    if (!name) { toast('Plugin name required'); return; }
    if (!tpl) { toast('Template required'); return; }

    const plugins = getPlugins();
    if (editingPluginId) {
      const idx = plugins.findIndex(p => p.id === editingPluginId);
      if (idx >= 0) {
        plugins[idx] = { ...plugins[idx], name, ext, mime, template: tpl };
      }
    } else {
      plugins.push({
        id: 'user-' + Date.now(),
        name, ext, mime, template: tpl,
        enabled: true,
        builtin: false
      });
    }
    savePlugins(plugins);
    $('plugin-editor').style.display = 'none';
    renderPluginList();
    toast('Plugin saved');
  };

  $('plugin-editor-test').onclick = () => {
    const song = getSong(currentSongId);
    if (!song) { toast('Open a song first'); return; }
    const tpl = $('plugin-editor-tpl').value;
    const ext = $('plugin-editor-ext').value.trim() || 'txt';
    try {
      const result = renderPluginTemplate(tpl, song);
      const output = $('plugin-test-output');
      output.style.display = 'block';
      output.textContent = result.substring(0, 2000) + (result.length > 2000 ? '\n…(truncated)' : '');
    } catch (e) {
      toast('Template error: ' + e.message);
    }
  };

  sheet.style.display = 'flex';
}

let editingPluginId = null;

function renderPluginList() {
  const list = $('plugin-list');
  const plugins = getPlugins();
  const song = getSong(currentSongId);

  list.innerHTML = plugins.map(p => `
    <div class="plugin-item ${p.enabled ? '' : 'disabled'}" data-id="${p.id}">
      <div class="plugin-item-info">
        <div class="plugin-item-name">${esc(p.name)}${p.builtin ? ' <span class="plugin-builtin-badge">built-in</span>' : ''}</div>
        <div class="plugin-item-meta">.${p.ext} · ${p.mime}</div>
      </div>
      <div class="plugin-item-actions">
        ${song ? `<button class="plugin-export-btn" data-id="${p.id}" title="Export">↑</button>` : ''}
        ${!p.builtin ? `<button class="plugin-edit-btn" data-id="${p.id}" title="Edit">✎</button>` : ''}
        ${!p.builtin ? `<button class="plugin-del-btn" data-id="${p.id}" title="Delete">✕</button>` : ''}
        <button class="plugin-toggle-btn" data-id="${p.id}" title="Toggle">${p.enabled ? '✓' : '○'}</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.plugin-export-btn').forEach(btn => {
    btn.onclick = () => {
      const plugin = plugins.find(p => p.id === btn.dataset.id);
      if (plugin && song) {
        exportWithPlugin(song, plugin);
        toast(`Exported as ${plugin.name}`);
      }
    };
  });

  list.querySelectorAll('.plugin-toggle-btn').forEach(btn => {
    btn.onclick = () => {
      const plugin = plugins.find(p => p.id === btn.dataset.id);
      if (plugin) {
        plugin.enabled = !plugin.enabled;
        savePlugins(plugins);
        renderPluginList();
      }
    };
  });

  list.querySelectorAll('.plugin-edit-btn').forEach(btn => {
    btn.onclick = () => {
      const plugin = plugins.find(p => p.id === btn.dataset.id);
      if (plugin) {
        editingPluginId = plugin.id;
        $('plugin-editor').style.display = 'flex';
        $('plugin-editor-name').value = plugin.name;
        $('plugin-editor-ext').value = plugin.ext;
        $('plugin-editor-mime').value = plugin.mime;
        $('plugin-editor-tpl').value = plugin.template;
        $('plugin-test-output').style.display = 'none';
      }
    };
  });

  list.querySelectorAll('.plugin-del-btn').forEach(btn => {
    btn.onclick = () => {
      showConfirmSheet({
        title: 'Delete Plugin',
        body: 'Delete this plugin?',
        confirmText: 'Delete',
        onConfirm: () => {
          const filtered = plugins.filter(p => p.id !== btn.dataset.id);
          savePlugins(filtered);
          renderPluginList();
          toast('Plugin deleted');
        }
      });
    };
  });
}

// Import
function importFiles(fileList) {
  const files = fileList || (() => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.txt,.md,.text,.cho,.crd,.chopro';
    inp.onchange = async e => { if (e.target.files.length) importFiles(e.target.files); };
    inp.click();
    return null;
  })();
  if (!files) return;
  (async () => {
    let n = 0, dups = 0, lastImported = null;
    for (const file of files) {
      try {
        const content = await file.text();
        const name = file.name.replace(/\.[^.]+$/, '');
        const imported = parseImported(name, content);
        if (isDuplicateTitle(imported.title)) { dups++; continue; }
        songs.unshift(imported); n++;
        lastImported = imported;
      } catch (err) {}
    }
    await saveSongs(); renderSongList();
    let msg = `Imported ${n} song${n !== 1 ? 's' : ''}`;
    if (dups) msg += ` (${dups} duplicate${dups !== 1 ? 's' : ''} skipped)`;
    // Report detected metadata from the last imported file
    if (lastImported) {
      const meta = [];
      if (lastImported.key) meta.push(`key ${lastImported.key}`);
      if (lastImported.bpm) meta.push(`${lastImported.bpm} BPM`);
      if (lastImported.time_sig) meta.push(`time ${lastImported.time_sig}`);
      if (meta.length) msg += ` · ${meta.join(', ')}`;
    }
    toast(msg);
  })();
}

// ===== Backup / Restore =====

function exportAllSongs() {
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    app: 'song-notes',
    songs: songs,
    folders: folders,
    setlists: setlists,
    trash: trash,
  };
  const json = JSON.stringify(backup, null, 2);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadFile(json, `song-notes-backup-${ts}.json`, 'application/json');
  toast(`Exported ${songs.length} song${songs.length !== 1 ? 's' : ''}`);
}

function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json';
  inp.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup || backup.app !== 'song-notes' || !Array.isArray(backup.songs)) {
        toast('Invalid backup file', 'error');
        return;
      }
      const incomingSongs = backup.songs;
      // Merge: skip duplicates by title, add new ones
      let added = 0, skipped = 0;
      const existingTitles = new Set(songs.map(s => (s.title || '').trim().toLowerCase()));
      for (const s of incomingSongs) {
        const t = (s.title || '').trim().toLowerCase();
        if (t && existingTitles.has(t)) { skipped++; continue; }
        if (t) existingTitles.add(t);
        songs.unshift(s);
        added++;
      }
      // Merge folders (union, keeping 'All Songs' first)
      if (Array.isArray(backup.folders)) {
        const existing = new Set(folders);
        for (const f of backup.folders) {
          if (!existing.has(f)) { folders.push(f); existing.add(f); }
        }
      }
      // Merge setlists (union by id)
      if (Array.isArray(backup.setlists)) {
        const existing = new Set(setlists.map(s => s.id));
        for (const s of backup.setlists) {
          if (!existing.has(s.id)) { setlists.push(s); existing.add(s.id); }
        }
      }
      // Merge trash
      if (Array.isArray(backup.trash)) {
        const existing = new Set(trash.map(t => t.song?.id));
        for (const t of backup.trash) {
          if (t.song?.id && !existing.has(t.song.id)) { trash.push(t); existing.add(t.song.id); }
        }
      }
      await saveSongs();
      safeStorageSet('folders_app', JSON.stringify(folders));
      safeStorageSet('sn_setlists', JSON.stringify(setlists));
      saveTrash();
      renderSongList();
      toast(`Imported ${added} song${added !== 1 ? 's' : ''}${skipped ? ` (${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped)` : ''}`);
    } catch (err) {
      toast('Failed to import backup', 'error');
    }
  };
  inp.click();
}

function parseChordPro(title, content) {
  const id = generateId();
  const lines = content.split('\n');
  const sections = [];
  let cur = { type: 'Verse', lines: [] };
  let key = '';
  let bpm = null;
  let songTitle = title;

  // ChordPro section directive names map
  const sectionMap = {
    'start_of_chorus': 'Chorus', 'soc': 'Chorus', 'start_of_bridge': 'Bridge', 'sob': 'Bridge',
    'start_of_verse': 'Verse', 'sov': 'Verse', 'start_of_intro': 'Intro', 'soi': 'Intro',
    'start_of_outro': 'Outro', 'soo': 'Outro', 'start_of_hook': 'Hook', 'soh': 'Hook',
    'start_of_refrain': 'Refrain', 'sor': 'Refrain', 'start_of_pre-chorus': 'Pre-Chorus',
    'start_of_interlude': 'Interlude', 'start_of_solo': 'Solo', 'start_of_instrumental': 'Instrumental',
    'start_of_tag': 'Tag', 'sot': 'Tag', 'start_of_coda': 'Coda', 'socd': 'Coda',
    'end_of_chorus': null, 'eoc': null, 'end_of_bridge': null, 'eob': null,
    'end_of_verse': null, 'eov': null, 'end_of_outro': null, 'eoo': null,
  };

  // Detect chord pattern: [A-G][#b]?(m|maj|min|dim|aug|sus|add|2|4|5|6|7|9|11|13)*(\/[A-G][#b]?)?
  const chordTagRe = /\[([A-G][#b]?(?:m(?:in)?|maj|dim|aug|sus|add)?\d*(?:\/[A-G][#b]?)?)\]/g;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    // Parse directives {name: value} or {name}
    const dirMatch = t.match(/^\{(\w[\w_-]*)(?::\s*(.+?))?\}$/);
    if (dirMatch) {
      const dir = dirMatch[1].toLowerCase();
      const val = (dirMatch[2] || '').trim();

      if (dir === 'title' || dir === 't') {
        if (val) songTitle = val;
        continue;
      }
      if (dir === 'key') {
        if (val) key = val;
        continue;
      }
      if (dir === 'tempo' || dir === 'bpm') {
        const n = parseInt(val, 10);
        if (!isNaN(n) && n > 0) bpm = n;
        continue;
      }

      // Section start directives
      const mapped = sectionMap[dir];
      if (mapped) {
        if (cur.lines.length) sections.push({ ...cur, lines: cur.lines });
        // Check for label like {start_of_chorus: Chorus 2}
        const labelMatch = val.match(/^(.+?)(?:\s+(\d+))?$/);
        if (labelMatch) {
          cur = { type: labelMatch[1] + (labelMatch[2] ? ' ' + labelMatch[2] : ''), lines: [] };
        } else {
          cur = { type: mapped, lines: [] };
        }
        continue;
      }

      // Section end directives — push current and start a generic one
      if (mapped === null) {
        if (cur.lines.length) sections.push({ ...cur, lines: cur.lines });
        cur = { type: 'Verse', lines: [] };
        continue;
      }

      // Skip other directives (comment, highlight, etc.)
      continue;
    }

    // Skip empty lines
    if (!t) {
      // If current section has lines, keep the empty line as spacing
      continue;
    }

    // Check if this line has chord tags
    const chords = [];
    let text = t;
    let m;
    chordTagRe.lastIndex = 0;
    while ((m = chordTagRe.exec(text)) !== null) {
      chords.push({ x: m.index * 8, name: m[1] });
    }
    text = text.replace(chordTagRe, '').trim();

    // If line was only chords (no text after removing tags), treat as chord-only line
    if (!text && chords.length) {
      cur.lines.push({ text: '', chords });
    } else if (text || chords.length) {
      cur.lines.push({ text: text || '', chords });
    }
  }

  if (cur.lines.length) sections.push({ ...cur, lines: cur.lines });

  // If no sections found, wrap everything
  if (!sections.length) sections.push({ type: 'Verse', lines: [{ text: content, chords: [] }] });

  return {
    id, title: songTitle, key, bpm, time_sig: null, tags: [], folder: null,
    sections, audio: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

function isChordPro(content) {
  // Detect ChordPro format: has {title:}, {key:}, {start_of_}, or {soc} directives
  return /^\{(?:title|t|key|start_of_|soc|eoc|sob|eob|sov|eov|soi|eoi|soo|eoo|soh|eoh|sor|eor|tempo|bpm|comment|highlight)\b/m.test(content);
}


function parseImported(title, content) {
  // Detect ChordPro format and delegate
  if (isChordPro(content)) {
    return parseChordPro(title, content);
  }

  const id = generateId();
  const lines = content.split('\n').filter(l => l.trim());
  const kw = ['verse', 'chorus', 'bridge', 'pre-chorus', 'outro', 'intro', 'hook', 'refrain'];
  const sections = [];
  let cur = { type: 'Verse', lines: [] };
  let hasSections = false;

  for (const raw of lines) {
    const t = raw.trim();
    const lower = t.toLowerCase().replace(/[^\w\s-]/g, '');
    let isHeader = false;
    for (const k of kw) {
      if (lower === k || lower.startsWith(k + ' ') || new RegExp(`^${k}\\s*\\d*$`).test(lower)) {
        if (cur.lines.length) sections.push({ ...cur, lines: cur.lines });
        let st = k.charAt(0).toUpperCase() + k.slice(1);
        const nm = t.match(/(\d+)/);
        if (nm) st += ' ' + nm[1];
        cur = { type: st, lines: [] }; isHeader = true; hasSections = true;
        break;
      }
    }
    if (!isHeader && t) {
      const chordRe = /\[([A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G][#b]?)?)\]/g;
      let text = t; const chords = []; let m;
      while ((m = chordRe.exec(text)) !== null) chords.push({ x: m.index * 8, name: m[1] });
      text = text.replace(chordRe, '').trim();
      cur.lines.push({ text, chords });
    }
  }
  if (cur.lines.length) sections.push({ ...cur, lines: cur.lines });

  if (!hasSections || !sections.length) sections.push({ type: 'Verse', lines: [{ text: content, chords: [] }] });

  let key = '';
  const km = content.match(/\bkey[:\s]+([A-G][#b]?m?)\b/i);
  if (km) key = km[1];

  // Detect BPM from common patterns: "BPM: 120", "Tempo: 120", "120 bpm", "♩=120"
  let bpm = null;
  const bpmPatterns = [
    /\b(?:bpm|tempo)[:\s=]+(\d{2,4})\b/i,
    /♩\s*=\s*(\d{2,4})\b/,
    /\b(\d{2,4})\s*bpm\b/i,
  ];
  for (const re of bpmPatterns) {
    const bm = content.match(re);
    if (bm) { const n = parseInt(bm[1], 10); if (n >= 20 && n <= 400) { bpm = n; break; } }
  }

  // Detect time signature from common patterns: "Time: 4/4", "4/4 time", "Time Sig: 3/4", "meter: 6/8"
  let time_sig = null;
  const timePatterns = [
    /\b(?:time(?: signature| sig)?|meter|metre)[:\s]+(\d+\/\d+)\b/i,
    /\b(\d+\/\d+)\s*(?:time|meter|metre)\b/i,
  ];
  for (const re of timePatterns) {
    const tm = content.match(re);
    if (tm) {
      const parts = tm[1].split('/');
      if (parts.length === 2) {
        const num = parseInt(parts[0], 10), den = parseInt(parts[1], 10);
        if (num >= 1 && num <= 16 && [2, 4, 8, 16].includes(den)) { time_sig = tm[1]; break; }
      }
    }
  }

  return { id, title, key, bpm, time_sig, tags: [], folder: null, sections, audio: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

// Duplicate title detection
function isDuplicateTitle(title, excludeId = null) {
  if (!title || !title.trim()) return false;
  const normalized = title.trim().toLowerCase();
  return songs.some(s => s.id !== excludeId && s.title && s.title.trim().toLowerCase() === normalized);
}

// Toast
function toast(msg, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type === 'error' ? 'error' : type === 'success' ? 'success' : 'info');
  el.textContent = msg;
  document.body.appendChild(el);
  const duration = type === 'error' ? 3000 : 2000;
  setTimeout(() => {
    el.classList.add('toast-exit');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback remove in case animation doesn't fire
    setTimeout(() => el.remove(), duration + 400);
  }, duration);
}

// Sample songs
function addSampleSongs() {
  if (songs.length > 0) return;
  const data = [
    { title: 'Blinding Lights', key: 'F#m', bpm: 171, sections: [
      { type: 'Intro', lines: [{ text: 'Yeah, yeah', chords: [{ x: 10, name: 'F#m' }] }, { text: '', chords: [] }] },
      { type: 'Verse', lines: [{ text: "I've been tryna call", chords: [{ x: 10, name: 'F#m' }] }, { text: "I've been on my own for long enough", chords: [{ x: 60, name: 'D' }] }, { text: 'Maybe you can show me how to love', chords: [{ x: 120, name: 'A' }] }, { text: "Maybe I'm going through withdrawals", chords: [{ x: 180, name: 'E' }] }] },
      { type: 'Chorus', lines: [{ text: "I said, ooh, I'm blinded by the lights", chords: [{ x: 10, name: 'F#m' }, { x: 180, name: 'D' }] }, { text: "No, I can't sleep until I feel your touch", chords: [{ x: 60, name: 'A' }, { x: 180, name: 'E' }] }] }
    ]},
    { title: 'Hallelujah', key: 'C', sections: [
      { type: 'Verse', lines: [{ text: "I've heard there was a secret chord", chords: [{ x: 10, name: 'C' }, { x: 180, name: 'Am' }] }, { text: 'That David played and it pleased the Lord', chords: [{ x: 10, name: 'C' }, { x: 180, name: 'Am' }] }, { text: "But you don't really care for music, do ya?", chords: [{ x: 10, name: 'F' }, { x: 100, name: 'G' }, { x: 200, name: 'C' }, { x: 280, name: 'G' }] }, { text: 'It goes like this: the fourth, the fifth', chords: [{ x: 10, name: 'C' }, { x: 120, name: 'F' }, { x: 200, name: 'G' }] }, { text: 'The minor fall, the major lift', chords: [{ x: 10, name: 'Am' }, { x: 150, name: 'F' }] }, { text: 'The baffled king composing Hallelujah', chords: [{ x: 10, name: 'G' }, { x: 130, name: 'E7' }, { x: 230, name: 'Am' }] }] },
      { type: 'Chorus', lines: [{ text: 'Hallelujah, Hallelujah', chords: [{ x: 10, name: 'F' }] }, { text: 'Hallelujah, Hallelu-u-u-jah', chords: [{ x: 10, name: 'Am' }, { x: 180, name: 'F' }, { x: 250, name: 'C' }, { x: 320, name: 'G' }] }] }
    ]},
    { title: 'New Song', key: 'G', bpm: 120, sections: [
      { type: 'Verse', lines: [{ text: 'Write your lyrics here', chords: [{ x: 10, name: 'G' }] }, { text: 'Tap above to add chords', chords: [{ x: 60, name: 'C' }] }] },
      { type: 'Chorus', lines: [{ text: 'This is the chorus', chords: [{ x: 10, name: 'G' }, { x: 120, name: 'Em' }] }, { text: 'Catchy and repeatable', chords: [{ x: 10, name: 'C' }, { x: 150, name: 'D' }] }] }
    ]},
    { title: '★ Welcome to Song Notes', key: 'G', bpm: 100, tutorial: true, sections: [
      { type: 'Intro', lines: [
        { text: '👋 This is your tutorial song!', chords: [] },
        { text: 'Tap the ✎ button below to edit any line.', chords: [{ x: 10, name: 'G' }] },
        { text: 'Tap above a line to add chords like this →', chords: [{ x: 10, name: 'C' }, { x: 280, name: 'G' }] }
      ]},
      { type: 'Verse', lines: [
        { text: 'Swipe left on any song → pin or delete it', chords: [{ x: 10, name: 'Em' }] },
        { text: 'Long-press a song to multi-select', chords: [{ x: 10, name: 'C' }] },
        { text: 'Tap ⋯ for tools: transpose, metronome, tuner', chords: [{ x: 10, name: 'G' }, { x: 200, name: 'D' }] }
      ]},
      { type: 'Chorus', lines: [
        { text: 'Try the ▤ gallery view in the toolbar!', chords: [{ x: 10, name: 'Am' }] },
        { text: 'Build setlists for gigs with ▤ → Setlists', chords: [{ x: 10, name: 'F' }, { x: 220, name: 'C' }] },
        { text: 'Export as text, markdown, or ChordPro format', chords: [{ x: 10, name: 'G' }, { x: 180, name: 'D' }] }
      ]},
      { type: 'Bridge', lines: [
        { text: 'Record audio, detect your key, use the tuner', chords: [{ x: 10, name: 'Em' }, { x: 200, name: 'Am' }] },
        { text: 'Set capo, view chord diagrams, tap tempo', chords: [{ x: 10, name: 'C' }, { x: 180, name: 'G' }] },
        { text: 'Search chords, add tags, create folders', chords: [{ x: 10, name: 'D' }, { x: 160, name: 'Em' }] }
      ]},
      { type: 'Outro', lines: [
        { text: 'You are ready to write your first song! 🎵', chords: [{ x: 10, name: 'C' }] },
        { text: 'Tap + to create a new song and start writing.', chords: [{ x: 10, name: 'G' }, { x: 240, name: 'D' }] },
        { text: 'This tutorial song will stay pinned up here.', chords: [{ x: 10, name: 'C' }, { x: 220, name: 'G' }] }
      ]}
    ]}
  ];
  data.forEach(d => {
    const song = createSong(d.title);
    song.key = d.key || ''; song.bpm = d.bpm || null;
    if (d.tutorial) song.tutorial = true;
    if (d.tutorial) song.pinned = true;
    song.sections = d.sections.map(s => ({ type: s.type, lines: s.lines.map(l => ({ text: l.text, chords: l.chords.map(c => ({ x: c.x, name: c.name })) })) }));
    songs.push(song);
  });
  saveSongs();
}

// Song templates
const SONG_TEMPLATES = {
  'Blank': { sections: [{ type: 'Verse', lines: [{ text: '', chords: [] }] }] },
  'Verse-Chorus': {
    sections: [
      { type: 'Verse', lines: [{ text: 'Verse lyrics', chords: [] }, { text: 'More lyrics here', chords: [] }] },
      { type: 'Chorus', lines: [{ text: 'Catchy chorus hook', chords: [] }, { text: 'Repeated refrain', chords: [] }] },
      { type: 'Verse', lines: [{ text: 'Second verse', chords: [] }] },
      { type: 'Chorus', lines: [{ text: 'Chorus again', chords: [] }] }
    ]
  },
  'AABA': {
    sections: [
      { type: 'A', lines: [{ text: 'First A section', chords: [] }] },
      { type: 'A', lines: [{ text: 'Second A section', chords: [] }] },
      { type: 'B', lines: [{ text: 'Bridge', chords: [] }] },
      { type: 'A', lines: [{ text: 'Final A section', chords: [] }] }
    ]
  },
  'Verse Only': {
    sections: [
      { type: 'Verse', lines: [{ text: '', chords: [] }, { text: '', chords: [] }] },
      { type: 'Verse', lines: [{ text: '', chords: [] }, { text: '', chords: [] }] }
    ]
  }
};

function showNewSongMenu() {
  const sheet = $('new-song-sheet');
  if (!sheet) return;

  const input = $('new-song-input');
  const createBtn = $('new-song-create-btn');
  const cancelBtn = $('new-song-cancel-btn');
  const backdrop = sheet.querySelector('.toolbar-sheet-backdrop');
  const templateBtns = sheet.querySelectorAll('.new-song-template-btn');

  let selectedTemplate = 'Blank';

  // Reset state
  input.value = '';
  templateBtns.forEach(b => b.classList.toggle('active', b.dataset.template === 'Blank'));
  sheet.style.display = 'flex';

  // Focus input after animation
  setTimeout(() => input.focus(), 100);

  // Template selection
  templateBtns.forEach(btn => {
    btn.onclick = () => {
      templateBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTemplate = btn.dataset.template;
    };
  });

  // Cancel
  const closeSheet = () => {
    sheet.style.display = 'none';
  };

  cancelBtn.onclick = closeSheet;
  backdrop.onclick = closeSheet;

  // Create
  const doCreate = () => {
    const title = input.value.trim() || 'Untitled';
    if (isDuplicateTitle(title)) {
      toast(`"${title}" already exists — use a different title`, 'error');
      input.focus();
      return;
    }
    const song = createSong(title);
    const template = SONG_TEMPLATES[selectedTemplate];
    if (template) {
      song.sections = template.sections.map(s => ({
        type: s.type,
        lines: s.lines.map(l => ({ text: l.text, chords: [] }))
      }));
    }
    closeSheet();
    songs.unshift(song); saveSingleSong(song);
    renderSongList(); currentSongId = song.id; openEditor(currentSongId); pushView('editor-view');
  };

  createBtn.onclick = doCreate;
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  };
}

// ===== Setlist Mode =====

function loadSetlists() {
  try { setlists = JSON.parse(localStorage.getItem('sn_setlists') || '[]'); } catch { setlists = []; }
}

function saveSetlists() {
  safeStorageSet('sn_setlists', JSON.stringify(setlists));
}

function getTransposedKey(key, semitones) {
  if (!key || !semitones) return key;
  const m = key.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return key;
  const root = m[1], suffix = m[2];
  const idx = noteToSemitone(root);
  return idx === -1 ? key : semitoneToNote(idx + semitones) + suffix;
}

function transposeSetlistSongData(song, semitones) {
  if (!song || !semitones) return;
  song.sections.forEach(s => s.lines.forEach(l => l.chords.forEach(c => {
    c.name = transposeChord(c.name, semitones);
  })));
  if (song.key) song.key = getTransposedKey(song.key, semitones);
}

// --- Setlist List View ---

function showSetlistView() {
  loadSetlists();
  renderSetlistList();
  pushView('setlist-view');
}

function renderSetlistList() {
  const el = $('setlist-list');
  if (!el) return;
  if (!setlists.length) {
    el.innerHTML = emptyStateHTML({ iconSvg: ICONS.setlist, title: 'No Setlists', desc: 'Organize songs into setlists for performances' });
    return;
  }
  el.innerHTML = setlists.map(sl => {
    const count = sl.songs.length;
    return `<div class="setlist-item" data-id="${sl.id}">
      <span class="setlist-item-icon">≡</span>
      <div class="setlist-item-info">
        <div class="setlist-item-name">${esc(sl.name)}</div>
        <div class="setlist-item-count">${count} song${count !== 1 ? 's' : ''}</div>
      </div>
      <div class="setlist-item-actions">
        <button class="setlist-delete-btn" data-id="${sl.id}" style="background:none;border:none;color:var(--danger);font-size:16px;padding:8px;cursor:pointer;">✕</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.setlist-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.setlist-delete-btn')) return;
      activeSetlistId = item.dataset.id;
      showSetlistDetail(activeSetlistId);
    });
  });
  el.querySelectorAll('.setlist-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const sl = setlists.find(s => s.id === id);
      if (!sl) return;
      showConfirmSheet({
        title: 'Delete Setlist',
        body: `Delete setlist "${sl.name}"?`,
        confirmText: 'Delete',
        onConfirm: () => {
          setlists = setlists.filter(s => s.id !== id);
          if (activeSetlistId === id) activeSetlistId = null;
          saveSetlists();
          renderSetlistList();
        }
      });
    });
  });
}

function createNewSetlist() {
  showInputSheet({
    title: 'New Setlist',
    placeholder: 'Setlist name',
    onConfirm: (name) => {
      const setlist = {
        id: 'sl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: name.trim(),
        songs: [],
        created_at: new Date().toISOString()
      };
      setlists.push(setlist);
      saveSetlists();
      activeSetlistId = setlist.id;
      renderSetlistList();
      showSetlistDetail(setlist.id);
    }
  });
}

// --- Setlist Detail View ---

function showSetlistDetail(id) {
  const setlist = setlists.find(s => s.id === id);
  if (!setlist) return;
  activeSetlistId = id;
  const titleEl = $('setlist-detail-title');
  if (titleEl) titleEl.textContent = setlist.name;
  renderSetlistSongs();
  pushView('setlist-detail-view');
}

function renderSetlistSongs() {
  const container = $('setlist-songs');
  const countEl = $('setlist-song-count');
  if (!container) return;

  const setlist = setlists.find(s => s.id === activeSetlistId);
  if (!setlist) {
    container.innerHTML = '<div class="empty-state"><p style="color:var(--fg-tertiary);font-size:14px;">Select a setlist</p></div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  if (countEl) countEl.textContent = `${setlist.songs.length} song${setlist.songs.length !== 1 ? 's' : ''}`;

  if (!setlist.songs.length) {
    container.innerHTML = emptyStateHTML({ iconSvg: ICONS.setlistAdd, title: 'Empty Setlist', desc: 'Tap + to add songs from your library' });
    return;
  }

  container.innerHTML = '';
  setlist.songs.forEach((entry, idx) => {
    const song = songs.find(s => s.id === entry.songId);
    const row = document.createElement('div');
    row.className = 'setlist-song-item';
    row.dataset.idx = idx;

    if (!song) {
      row.innerHTML = `
        <span class="setlist-song-drag">⋮⋮</span>
        <div class="setlist-song-info"><div class="setlist-song-title" style="color:var(--fg-tertiary)">Unknown song</div></div>
        <button class="setlist-song-remove" data-idx="${idx}">✕</button>`;
    } else {
      const effectiveKey = getTransposedKey(song.key, entry.transpose || 0);
      const lineCount = (song.sections||[]).reduce((a, sec) => a + sec.lines.length, 0);
      row.innerHTML = `
        <span class="setlist-song-drag" data-idx="${idx}">⋮⋮</span>
        <div class="setlist-song-info">
          <div class="setlist-song-title">${esc(song.title || 'Untitled')}</div>
          <div class="setlist-song-meta">
            <span class="setlist-song-key">${effectiveKey || '—'}</span>
            ${entry.capo ? `<span class="setlist-song-capo"> · Capo ${entry.capo}</span>` : ''}
            ${entry.transpose ? ` · ${entry.transpose > 0 ? '+' : ''}${entry.transpose}` : ''}
            · ${lineCount} lines
          </div>
        </div>
        <div class="setlist-song-controls">
          <input type="number" class="setlist-capo-input" data-idx="${idx}" value="${entry.capo || 0}" min="0" max="11" title="Capo">
          <button class="setlist-song-remove" data-idx="${idx}" title="Remove">✕</button>
        </div>`;
    }

    container.appendChild(row);
  });

  // Wire up events
  container.querySelectorAll('.setlist-capo-input').forEach(input => {
    input.addEventListener('change', e => {
      const idx = parseInt(e.target.dataset.idx);
      const setlist = setlists.find(s => s.id === activeSetlistId);
      if (!setlist || !setlist.songs[idx]) return;
      setlist.songs[idx].capo = parseInt(e.target.value) || 0;
      saveSetlists();
    });
  });

  container.querySelectorAll('.setlist-song-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const setlist = setlists.find(s => s.id === activeSetlistId);
      if (!setlist) return;
      const song = songs.find(s => s.id === setlist.songs[idx]?.songId);
      if (!song) return;
      showConfirmSheet({
        title: 'Remove Song',
        body: `Remove "${song.title}" from setlist?`,
        confirmText: 'Remove',
        confirmClass: 'neutral',
        onConfirm: () => {
          setlist.songs.splice(idx, 1);
          saveSetlists();
          renderSetlistSongs();
        }
      });
    });
  });

  // Touch drag-to-reorder
  let dragIdx = null;
  let touchStartY = 0;
  let dragClone = null;

  container.querySelectorAll('.setlist-song-item').forEach(row => {
    const dragHandle = row.querySelector('.setlist-song-drag');

    // Mouse drag
    row.draggable = true;
    row.addEventListener('dragstart', () => {
      dragIdx = parseInt(row.dataset.idx);
      row.style.opacity = '0.4';
    });
    row.addEventListener('dragend', () => {
      row.style.opacity = '';
      dragIdx = null;
    });
    row.addEventListener('dragover', e => { e.preventDefault(); });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const dropIdx = parseInt(row.dataset.idx);
      const setlist = setlists.find(s => s.id === activeSetlistId);
      if (dragIdx !== null && setlist && dragIdx !== dropIdx) {
        const [moved] = setlist.songs.splice(dragIdx, 1);
        setlist.songs.splice(dropIdx, 0, moved);
        saveSetlists();
        renderSetlistSongs();
      }
    });

    // Touch drag via handle
    if (dragHandle) {
      dragHandle.addEventListener('touchstart', e => {
        touchStartY = e.touches[0].clientY;
        dragIdx = parseInt(row.dataset.idx);
      }, { passive: true });
      dragHandle.addEventListener('touchmove', e => {
        if (dragIdx === null) return;
        const touch = e.touches[0];
        const containerRect = container.getBoundingClientRect();
        const rows = container.querySelectorAll('.setlist-song-item');
        // Find which row we're over
        rows.forEach((r, i) => {
          const rect = r.getBoundingClientRect();
          if (touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
            if (i !== dragIdx) {
              const setlist = setlists.find(s => s.id === activeSetlistId);
              if (setlist) {
                const [moved] = setlist.songs.splice(dragIdx, 1);
                setlist.songs.splice(i, 0, moved);
                saveSetlists();
                dragIdx = i;
                renderSetlistSongs();
              }
            }
          }
        });
      }, { passive: false });
      dragHandle.addEventListener('touchend', () => {
        dragIdx = null;
      }, { passive: true });
    }
  });
}

// --- Song Picker ---

function showSongPicker() {
  const setlist = setlists.find(s => s.id === activeSetlistId);
  if (!setlist) { toast('Create a setlist first'); return; }
  if (!songs.length) { toast('No songs available'); return; }

  const sheet = $('song-picker-sheet');
  const list = $('song-picker-list');
  const searchInput = $('song-picker-search');
  if (!sheet || !list) return;

  // Virtual scroll constants
  const ITEM_HEIGHT = 52; // px per song row (padding + font + meta + border)
  const BUFFER_ITEMS = 8; // extra items above/below viewport

  const renderList = (filter = '') => {
    const q = filter.toLowerCase().trim();
    const filtered = q
      ? songs.filter(s => (s.title || '').toLowerCase().includes(q) || (s.key || '').toLowerCase().includes(q) || (s.tags || []).some(t => t.toLowerCase().includes(q)))
      : songs;

    if (!filtered.length) {
      list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--fg-tertiary);font-size:14px;">No matching songs</div>`;
      // Clean up any existing scroll handler
      if (list._virtualScrollHandler) {
        list.removeEventListener('scroll', list._virtualScrollHandler);
        list._virtualScrollHandler = null;
      }
      return;
    }

    // Store filtered data for virtual scrolling
    list._filteredSongs = filtered;

    // Set up the scroll container with a spacer for total height
    list.innerHTML = `<div class="virtual-scroll-spacer" style="position:relative;height:${filtered.length * ITEM_HEIGHT}px;"></div>`;
    const spacer = list.querySelector('.virtual-scroll-spacer');

    // Render visible items
    const renderVisible = () => {
      const scrollTop = list.scrollTop;
      const viewportH = list.clientHeight;
      const startIdx = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_ITEMS);
      const endIdx = Math.min(filtered.length, Math.ceil((scrollTop + viewportH) / ITEM_HEIGHT) + BUFFER_ITEMS);

      // Build HTML for visible slice
      let html = '';
      for (let i = startIdx; i < endIdx; i++) {
        const s = filtered[i];
        const alreadyIn = setlist.songs.some(ss => ss.songId === s.id);
        const lineCount = (s.sections||[]).reduce((a, sec) => a + sec.lines.length, 0);
        const top = i * ITEM_HEIGHT;
        html += `<div class="song-picker-item${alreadyIn ? ' already-in' : ''}" data-id="${s.id}" style="position:absolute;top:${top}px;left:0;right:0;height:${ITEM_HEIGHT}px;">
      <div style="flex:1;min-width:0;">
        <div class="song-picker-title">${esc(s.title || 'Untitled')}</div>
        <div class="song-picker-meta">${s.key || 'No key'} · ${lineCount} lines</div>
      </div>
      ${alreadyIn ? '<span style="color:var(--fg-tertiary);font-size:13px;">Added</span>' : ''}
    </div>`;
      }
      spacer.innerHTML = html;

      // Attach click handlers
      spacer.querySelectorAll('.song-picker-item:not(.already-in)').forEach(item => {
        item.addEventListener('click', () => {
          const songId = item.dataset.id;
          setlist.songs.push({ songId, capo: 0, transpose: 0 });
          saveSetlists();
          renderSetlistSongs();
          sheet.style.display = 'none';
          toast('Added to setlist');
        });
      });
    };

    renderVisible();

    // Debounced scroll handler
    if (list._virtualScrollHandler) {
      list.removeEventListener('scroll', list._virtualScrollHandler);
    }
    let scrollRAF = null;
    list._virtualScrollHandler = () => {
      if (scrollRAF) return;
      scrollRAF = requestAnimationFrame(() => {
        scrollRAF = null;
        renderVisible();
      });
    };
    list.addEventListener('scroll', list._virtualScrollHandler);
  };

  renderList();

  // Live search filter
  if (searchInput) {
    searchInput.value = '';
    searchInput.addEventListener('input', () => {
      renderList(searchInput.value);
    });
    // Focus search input after sheet opens
    setTimeout(() => searchInput.focus(), 150);
  }

  sheet.style.display = 'flex';
  sheet.querySelector('.toolbar-sheet-backdrop').onclick = () => { sheet.style.display = 'none'; };
}

// --- Transpose All ---

function showTransposeSheet() {
  const setlist = setlists.find(s => s.id === activeSetlistId);
  if (!setlist) return;

  // Build or reuse transpose sheet
  let sheet = $('transpose-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'transpose-sheet';
    sheet.innerHTML = `
      <div class="toolbar-sheet-backdrop"></div>
      <div class="toolbar-sheet-content">
        <div class="toolbar-sheet-handle"></div>
        <h3 style="font-size:17px;font-weight:600;padding:4px 0 12px;text-align:center;">Transpose All Songs</h3>
        <div class="transpose-grid">
          ${[-6,-5,-4,-3,-2,-1].map(i => `<button class="transpose-btn" data-semitones="${i}">${i > 0 ? '+' : ''}${i}</button>`).join('')}
          <button class="transpose-btn reset" data-semitones="0">↺ Reset to Original</button>
          ${[1,2,3,4,5,6].map(i => `<button class="transpose-btn" data-semitones="${i}">+${i}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.toolbar-sheet-backdrop').addEventListener('click', () => { sheet.style.display = 'none'; });
  }

  sheet.querySelectorAll('.transpose-btn').forEach(btn => {
    btn.onclick = () => {
      const semitones = parseInt(btn.dataset.semitones);
      if (semitones === 0) {
        setlist.songs.forEach(s => s.transpose = 0);
        saveSetlists();
        renderSetlistSongs();
        sheet.style.display = 'none';
        toast('Reset to original');
      } else {
        setlist.songs.forEach(s => s.transpose = (s.transpose || 0) + semitones);
        saveSetlists();
        renderSetlistSongs();
        sheet.style.display = 'none';
        toast(`${semitones > 0 ? '+' : ''}${semitones} semitones`);
      }
    };
  });

  sheet.style.display = 'flex';
}

// --- Print / Chord Chart Preview ---

function showSetlistPrintPreview() {
  const setlist = setlists.find(s => s.id === activeSetlistId);
  if (!setlist || !setlist.songs.length) { toast('No songs in setlist'); return; }

  const overlay = $('setlist-print-overlay');
  const content = $('setlist-print-content');
  const title = $('print-preview-title');
  if (!overlay || !content) return;

  if (title) title.textContent = `Setlist: ${setlist.name}`;

  let html = `<div class="pp-title">${esc(setlist.name)}</div>`;
  html += `<div class="pp-subtitle">${setlist.songs.length} song${setlist.songs.length !== 1 ? 's' : ''}</div>`;

  setlist.songs.forEach((entry, idx) => {
    const song = songs.find(s => s.id === entry.songId);
    if (!song) return;

    // Build transposed copy for display (capo + transpose)
    const displaySong = JSON.parse(JSON.stringify(song));
    const totalSemitones = (entry.transpose || 0) + (entry.capo || 0);
    if (totalSemitones) transposeSetlistSongData(displaySong, totalSemitones);

    html += `<div class="pp-song-block">`;
    html += `<div class="pp-song-title">${idx + 1}. ${esc(song.title || 'Untitled')}`;
    if (entry.capo) html += ` <span class="pp-song-capo">(Capo ${entry.capo})</span>`;
    if (entry.transpose) html += ` <span class="pp-song-capo">(${entry.transpose > 0 ? '+' : ''}${entry.transpose})</span>`;
    html += `</div>`;

    displaySong.sections.forEach(section => {
      html += `<div class="pp-section-type">${esc(section.type)}</div>`;
      if (section.strumming) html += `<div class="pp-strumming">♫ ${esc(section.strumming)}</div>`;
      section.lines.forEach(line => {
        if (line.chords && line.chords.length) {
          let chordLine = '';
          let lx = 0;
          line.chords.sort((a, b) => a.x - b.x).forEach(ch => {
            const sp = Math.max(0, Math.floor((ch.x - lx) / 7));
            chordLine += ' '.repeat(sp) + ch.name;
            lx = ch.x + ch.name.length * 7;
          });
          if (chordLine.trim()) html += `<div class="pp-chord-line">${esc(chordLine)}</div>`;
        }
        if (line.text) html += `<div class="pp-lyric-line">${esc(line.text)}</div>`;
      });
    });
    html += `</div>`;
  });

  content.innerHTML = html;
  overlay.style.display = 'flex';
}

// Show print preview for the current song (individual song chord chart)
function showSongPrintPreview() {
  const song = getSong(currentSongId);
  if (!song) return;

  const overlay = $('setlist-print-overlay');
  const content = $('setlist-print-content');
  const title = $('print-preview-title');
  if (!overlay || !content) return;

  if (title) title.textContent = song.title || 'Untitled';

  let html = `<div class="pp-title">${esc(song.title || 'Untitled')}</div>`;
  if (song.key) html += `<div class="pp-subtitle">Key: ${esc(song.key)}${song.bpm ? ` · ${song.bpm} BPM` : ''}</div>`;

  song.sections?.forEach(section => {
    html += `<div class="pp-song-block">`;
    html += `<div class="pp-section-type">${esc(section.type)}</div>`;
      if (section.strumming) html += `<div class="pp-strumming">♫ ${esc(section.strumming)}</div>`;
      section.lines?.forEach(line => {
      if (line.chords?.length) {
        let chordLine = '';
        let lx = 0;
        line.chords.sort((a, b) => a.x - b.x).forEach(ch => {
          const sp = Math.max(0, Math.floor((ch.x - lx) / 7));
          chordLine += ' '.repeat(sp) + ch.name;
          lx = ch.x + ch.name.length * 7;
        });
        if (chordLine.trim()) html += `<div class="pp-chord-line">${esc(chordLine)}</div>`;
      }
      if (line.text) html += `<div class="pp-lyric-line">${esc(line.text)}</div>`;
    });
    html += `</div>`;
  });

  content.innerHTML = html;
  overlay.style.display = 'flex';
}

// Events
// Delegated song-list events: single listener on #song-list handles all
// song-item interactions (click-to-open, swipe, long-press, action buttons)
(function initSongListDelegation() {
  const list = $('song-list');
  if (!list) return;

  const SWIPE_THRESHOLD = 50;
  const MAX_OPEN = 192;

  // Close any open swipe when touching elsewhere on the list
  document.addEventListener('touchstart', (e) => {
    list.querySelectorAll('.swiped').forEach(item => {
      const c = item.querySelector('.swipe-content');
      if (c && !item.contains(e.target)) {
        c.style.transition = 'transform 0.2s ease';
        c.style.transform = 'translateX(0)';
        item.classList.remove('swiped');
        swipeState.delete(item);
      }
    });
  }, { passive: true });

  list.addEventListener('touchstart', (e) => {
    const item = e.target.closest('.swipe-item');
    if (!item) return;
    const content = item.querySelector('.swipe-content');
    if (!content) return;
    // Skip if tapping action buttons
    if (e.target.closest('.swipe-bg')) return;

    // Initialize swipe state for this item
    if (!swipeState.has(item)) {
      swipeState.set(item, { startX: 0, startY: 0, currentX: 0, isSwiping: false, isOpen: false, longPressTimer: null });
    }
    const st = swipeState.get(item);
    st.startX = e.changedTouches[0].clientX;
    st.startY = e.changedTouches[0].clientY;
    st.isSwiping = false;

    // Long press timer — enters multi-select mode (only on touch)
    st.longPressTimer = setTimeout(() => {
      st.longPressTimer = null;
      const songId = item.dataset.id;
      if (songId) {
        haptic(30);
        enterMultiSelectMode(songId);
        // Show long-press hint on first multi-select
        if (!featureHints['longpress-multiselect']) {
          markHintShown('longpress-multiselect');
          setTimeout(() => {
            const bar = document.querySelector('.multi-select-bar');
            if (bar) showFeatureHint(bar, 'Long-press any song to multi-select', 'top');
          }, 300);
        }
      }
      st.isSwiping = true; // prevent click
    }, 500);
  }, { passive: true });

  list.addEventListener('touchmove', (e) => {
    const item = e.target.closest('.swipe-item');
    const st = swipeState.get(item);
    if (!st || !st.startX) return;
    const content = item.querySelector('.swipe-content');
    if (!content) return;

    st.currentX = e.changedTouches[0].clientX;
    const diffX = st.startX - st.currentX;
    const diffY = Math.abs(e.changedTouches[0].clientY - st.startY);

    if (!st.isSwiping && diffX > 15 && diffY < 20) {
      st.isSwiping = true;
      if (st.longPressTimer) { clearTimeout(st.longPressTimer); st.longPressTimer = null; }
    }
    if (!st.isSwiping) return;

    if (diffY < Math.abs(diffX)) e.preventDefault();

    content.style.transition = 'none';
    if (st.isOpen) {
      content.style.transform = `translateX(${Math.max(0, Math.min(MAX_OPEN, MAX_OPEN - diffX))}px)`;
    } else if (diffX > 0) {
      content.style.transform = `translateX(${Math.min(diffX, MAX_OPEN) * -1}px)`;
    }
  }, { passive: false });

  list.addEventListener('touchend', (e) => {
    const item = e.target.closest('.swipe-item');
    const st = swipeState.get(item);
    if (!st) return;
    const content = item.querySelector('.swipe-content');
    if (!content) return;

    if (st.longPressTimer) { clearTimeout(st.longPressTimer); st.longPressTimer = null; }

    if (st.isSwiping) {
      const diffX = st.startX - st.currentX;
      content.style.transition = 'transform 0.2s ease';
      if (st.isOpen) {
        if (diffX < -30) {
          content.style.transform = 'translateX(0)';
          st.isOpen = false;
          item.classList.remove('swiped');
        } else {
          content.style.transform = `translateX(${-MAX_OPEN}px)`;
        }
      } else {
        if (diffX > SWIPE_THRESHOLD) {
            content.style.transform = `translateX(${-MAX_OPEN}px)`;
            st.isOpen = true;
            item.classList.add('swiped');
            haptic(15);
            // Show swipe-to-action hint on first swipe
            if (!featureHints['swipe-actions']) {
              markHintShown('swipe-actions');
              showFeatureHint(item, 'Swipe left for quick actions', 'left');
            }
          } else {
          content.style.transform = 'translateX(0)';
          st.isOpen = false;
          item.classList.remove('swiped');
        }
      }
    }
    st.isSwiping = false;
    st.startX = 0;
  }, { passive: true });

  // Click handler: open song or trigger action buttons
  list.addEventListener('click', async (e) => {
    const item = e.target.closest('.swipe-item');
    if (!item) return;
    const songId = item.dataset.id;
    if (!songId) return;

    // Multi-select mode: tap toggles selection
    if (multiSelectMode) {
      if (e.target.closest('.swipe-bg') || e.target.closest('.gallery-card-actions')) return;
      toggleSongSelection(songId);
      return;
    }

    // Action buttons in swipe background
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      const s = getSong(songId);
      if (!s) return;
      haptic(15);
      if (action === 'pin') {
        s.pinned = !s.pinned;
        await saveSingleSong(s);
        renderSongList($('search-input')?.value || '');
        toast(s.pinned ? 'Pinned ★' : 'Unpinned');
      } else if (action === 'duplicate') {
        const copy = JSON.parse(JSON.stringify(s));
        copy.id = generateId();
        copy.title = (s.title || 'Untitled') + ' (Copy)';
        copy.created_at = new Date().toISOString();
        copy.updated_at = new Date().toISOString();
        copy.pinned = false;
        songs.unshift(copy);
        await saveSongs();
        renderSongList($('search-input')?.value || '');
        toast('Duplicated');
      } else if (action === 'delete') {
        showConfirmSheet({
          title: 'Delete Song',
          body: `Move "${esc(s.title || 'Untitled')}" to trash?`,
          confirmText: 'Delete',
          onConfirm: async () => {
            await deleteSong(songId);
            if (currentSongId === songId) currentSongId = null;
            renderSongList($('search-input')?.value || '');
            toast('Moved to trash');
          }
        });
      }
      return;
    }

    // Gallery card action buttons
    const galleryAction = e.target.closest('.gallery-card-pin, .gallery-card-delete');
    if (galleryAction) {
      const s = getSong(songId);
      if (!s) return;
      if (galleryAction.classList.contains('gallery-card-pin')) {
        s.pinned = !s.pinned;
        await saveSingleSong(s);
        renderSongList($('search-input')?.value || '');
        toast(s.pinned ? '★ Pinned' : '☆ Unpinned');
      } else {
        showConfirmSheet({
          title: 'Delete Song',
          body: 'Move to trash? You can restore it within 30 days.',
          confirmText: 'Delete',
          confirmClass: 'sheet-danger',
          onConfirm: async () => {
            await deleteSong(songId);
            if (currentSongId === songId) currentSongId = null;
            renderSongList($('search-input')?.value || '');
            toast('Moved to trash');
          }
        });
      }
      return;
    }

    // Play recording button — toggle play/pause
    const playRecBtn = e.target.closest('.song-play-rec-btn');
    if (playRecBtn) {
      const s = getSong(songId);
      if (s && s.audio && s.audio.length > 0) {
        if (currentPlayingSongId === songId && !audioPlayer.paused) {
          audioPlayer.pause();
          currentPlayingSongId = null;
        } else {
          if (!audioPlayer.paused) { audioPlayer.pause(); }
          const lastRec = s.audio[s.audio.length - 1];
          playRecording(lastRec.data);
          currentPlayingSongId = songId;
        }
        renderSongList($('search-input')?.value || '');
      }
      return;
    }

    // Click on card/content to open song
    const st = swipeState.get(item);
    if (st && st.isOpen) return; // don't open if swipe was just closed

    const content = item.querySelector('.swipe-content') || item.querySelector('.gallery-card');
    if (!content) return;
    // Only open if click wasn't on an interactive element
    if (e.target.closest('.gallery-card-actions') || e.target.closest('.swipe-bg')) return;

    currentSongId = songId;
    safeStorageSet('songs_app_last', currentSongId);
    openEditor(currentSongId);
    pushView('editor-view');
  });

  // Right-click (desktop) to enter multi-select or toggle selection
  list.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.swipe-item') || e.target.closest('.gallery-card');
    if (!item) return;
    const songId = item.dataset.id;
    if (!songId) return;
    e.preventDefault();
    if (multiSelectMode) {
      toggleSongSelection(songId);
    } else {
      enterMultiSelectMode(songId);
    }
  });
})();

// ===== Multi-Select Mode =====
function enterMultiSelectMode(songId) {
  multiSelectMode = true;
  selectedSongIds = new Set([songId]);
  document.body.classList.add('multi-select-mode');
  renderSongList($('search-input')?.value || '');
  renderMultiSelectBar();
  updateMultiSelectBar();
}

function exitMultiSelectMode() {
  multiSelectMode = false;
  selectedSongIds.clear();
  document.body.classList.remove('multi-select-mode');
  const bar = $('multi-select-bar');
  if (bar) bar.remove();
  renderSongList($('search-input')?.value || '');
}

function toggleSongSelection(songId) {
  if (selectedSongIds.has(songId)) {
    selectedSongIds.delete(songId);
    if (selectedSongIds.size === 0) {
      exitMultiSelectMode();
      return;
    }
  } else {
    selectedSongIds.add(songId);
  }
  updateMultiSelectBar();
  document.querySelectorAll('.swipe-item, .gallery-card').forEach(el => {
    const id = el.dataset.id;
    el.classList.toggle('selected', selectedSongIds.has(id));
  });
}

function renderMultiSelectBar() {
  if ($('multi-select-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'multi-select-bar';
  bar.innerHTML = `
    <button class="ms-bar-close" aria-label="Exit selection">✕</button>
    <span class="ms-bar-count" id="ms-bar-count">1 selected</span>
    <div class="ms-bar-actions">
      <button class="ms-bar-btn" data-ms-action="selectall" aria-label="Select all">☑</button>
      <button class="ms-bar-btn" data-ms-action="pin" aria-label="Pin selected">★</button>
      <button class="ms-bar-btn" data-ms-action="duplicate" aria-label="Duplicate selected">⧉</button>
      <button class="ms-bar-btn" data-ms-action="folder" aria-label="Move to folder">◎</button>
      <button class="ms-bar-btn" data-ms-action="setlist" aria-label="Add to setlist">≡</button>
      <button class="ms-bar-btn ms-bar-danger" data-ms-action="delete" aria-label="Delete selected">✕</button>
    </div>`;
  document.body.appendChild(bar);

  bar.querySelector('.ms-bar-close').addEventListener('click', exitMultiSelectMode);
  bar.querySelectorAll('.ms-bar-btn').forEach(btn => {
    btn.addEventListener('click', () => handleBulkAction(btn.dataset.msAction));
  });
}

function updateMultiSelectBar() {
  const count = selectedSongIds.size;
  const el = $('ms-bar-count');
  if (el) el.textContent = count + ' selected';
  // Toggle select-all button icon based on visible items
  const btn = document.querySelector('#multi-select-bar .ms-bar-btn[data-ms-action="selectall"]');
  if (btn) {
    const visibleItems = document.querySelectorAll('#song-list .swipe-item, #song-list .gallery-card');
    const visibleIds = [...visibleItems].map(el => el.dataset.id).filter(Boolean);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedSongIds.has(id));
    btn.textContent = allSelected ? '☐' : '☑';
    btn.setAttribute('aria-label', allSelected ? 'Deselect all' : 'Select all');
  }
}

async function handleBulkAction(action) {
  const ids = [...selectedSongIds];
  if (!ids.length && action !== 'selectall') return;

  if (action === 'selectall') {
    // Check if all visible items (matching current search filter) are selected
    const visibleItems = document.querySelectorAll('#song-list .swipe-item, #song-list .gallery-card');
    const visibleIds = [...visibleItems].map(el => el.dataset.id).filter(Boolean);
    const allSelected = visibleIds.length > 0 && visibleIds.every(id => selectedSongIds.has(id));
    if (allSelected) {
      // Deselect all visible
      visibleIds.forEach(id => selectedSongIds.delete(id));
      if (selectedSongIds.size === 0) exitMultiSelectMode();
      else updateMultiSelectBar();
      visibleItems.forEach(el => el.classList.remove('selected'));
      return;
    }
    // Select all visible
    visibleIds.forEach(id => selectedSongIds.add(id));
    updateMultiSelectBar();
    visibleItems.forEach(el => el.classList.add('selected'));
    return;
  }

  if (action === 'delete') {
    const count = ids.length;
    showConfirmSheet({
      title: 'Delete Songs',
      body: 'Move ' + count + ' song' + (count !== 1 ? 's' : '') + ' to trash?',
      confirmText: 'Delete',
      confirmClass: 'sheet-danger',
      onConfirm: async () => {
        for (const id of ids) await deleteSong(id);
        toast('Moved ' + count + ' song' + (count !== 1 ? 's' : '') + ' to trash');
        exitMultiSelectMode();
      }
    });
  } else if (action === 'pin') {
    const allPinned = ids.every(id => getSong(id)?.pinned);
    for (const id of ids) {
      const s = getSong(id);
      if (s) { s.pinned = !allPinned; await saveSingleSong(s); }
    }
    toast(allPinned ? 'Unpinned' : 'Pinned');
    exitMultiSelectMode();
  } else if (action === 'duplicate') {
    for (const id of ids) {
      const s = getSong(id);
      if (!s) continue;
      const copy = JSON.parse(JSON.stringify(s));
      copy.id = generateId();
      copy.title = (s.title || 'Untitled') + ' (Copy)';
      copy.pinned = false;
      copy.created_at = new Date().toISOString();
      copy.updated_at = new Date().toISOString();
      songs.unshift(copy);
    }
    await saveSongs();
    toast('Duplicated ' + ids.length + ' song' + (ids.length !== 1 ? 's' : ''));
    exitMultiSelectMode();
  } else if (action === 'folder') {
    showBulkMoveToFolderSheet(ids);
  } else if (action === 'setlist') {
    showBulkAddToSetlistSheet(ids);
  }
}

// ===== Bulk Move to Folder =====
function showBulkMoveToFolderSheet(songIds) {
  const sheet = document.createElement('div');
  sheet.className = 'confirm-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Move to folder');

  const customFolders = folders.filter(f => f !== 'All Songs' && f !== 'Recently Edited');
  let folderListHtml = `<button class="folder-picker-item selected" data-folder="">
    <span class="folder-picker-icon">♫</span>
    <span class="folder-picker-name">All Songs</span>
    <span class="folder-picker-check">✓</span></button>`;

  customFolders.forEach(f => {
    folderListHtml += `<button class="folder-picker-item" data-folder="${escHtml(f)}">
      <span class="folder-picker-icon">♪</span>
      <span class="folder-picker-name">${escHtml(f)}</span></button>`;
  });

  if (!customFolders.length) {
    folderListHtml += '<div class="folder-picker-empty">No custom folders yet</div>';
  }

  sheet.innerHTML = `<div class="confirm-sheet-backdrop"></div>
    <div class="confirm-sheet-content" style="max-height:60vh;">
    <div class="confirm-sheet-handle"></div>
    <div class="confirm-sheet-title">Move ${songIds.length} Song${songIds.length !== 1 ? 's' : ''} to Folder</div>
    <div class="folder-picker-list">${folderListHtml}</div>
    <div class="confirm-sheet-actions">
    <button class="confirm-sheet-cancel">Cancel</button></div></div>`;

  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.querySelector('.confirm-sheet-backdrop').onclick = close;
  sheet.querySelector('.confirm-sheet-cancel').onclick = close;
  enableDragToDismiss(sheet, { contentSelector: '.confirm-sheet-content', backdropSelector: '.confirm-sheet-backdrop', onDismiss: close });

  sheet.querySelectorAll('.folder-picker-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetFolder = btn.dataset.folder || null;
      for (const id of songIds) {
        const s = getSong(id);
        if (s) { s.folder = targetFolder; s.updated_at = new Date().toISOString(); await saveSingleSong(s); }
      }
      renderSongList($('search-input')?.value || '');
      toast(targetFolder ? 'Moved to ' + targetFolder : 'Moved to All Songs');
      close();
      exitMultiSelectMode();
    });
  });
}

// ===== Bulk Add to Setlist =====
function showBulkAddToSetlistSheet(songIds) {
  if (!setlists.length) {
    showInputSheet({
      title: 'New Setlist',
      placeholder: 'Setlist name',
      onConfirm: async (name) => {
        const sl = { id: generateId(), name, songs: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        setlists.push(sl);
        safeStorageSet('sn_setlists', JSON.stringify(setlists));
        for (const id of songIds) sl.songs.push({ id, capo: null, transpose: 0 });
        safeStorageSet('sn_setlists', JSON.stringify(setlists));
        toast('Created "' + name + '" with ' + songIds.length + ' song' + (songIds.length !== 1 ? 's' : ''));
        exitMultiSelectMode();
      }
    });
    return;
  }

  const sheet = document.createElement('div');
  sheet.className = 'confirm-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Add to setlist');

  let setlistHtml = '';
  setlists.forEach(sl => {
    setlistHtml += `<button class="folder-picker-item" data-setlist-id="${sl.id}">
      <span class="folder-picker-icon">≡</span>
      <span class="folder-picker-name">${escHtml(sl.name)}</span>
      <span class="folder-picker-count">${sl.songs.length}</span></button>`;
  });

  sheet.innerHTML = `<div class="confirm-sheet-backdrop"></div>
    <div class="confirm-sheet-content" style="max-height:60vh;">
    <div class="confirm-sheet-handle"></div>
    <div class="confirm-sheet-title">Add to Setlist</div>
    <div class="folder-picker-list">${setlistHtml}</div>
    <div class="confirm-sheet-or">— or —</div>
    <button class="confirm-sheet-create" id="ms-new-setlist">+ New Setlist</button>
    <div class="confirm-sheet-actions">
    <button class="confirm-sheet-cancel">Cancel</button></div></div>`;

  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.querySelector('.confirm-sheet-backdrop').onclick = close;
  sheet.querySelector('.confirm-sheet-cancel').onclick = close;
  enableDragToDismiss(sheet, { contentSelector: '.confirm-sheet-content', backdropSelector: '.confirm-sheet-backdrop', onDismiss: close });

  sheet.querySelectorAll('.folder-picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const slId = btn.dataset.setlistId;
      const sl = setlists.find(s => s.id === slId);
      if (!sl) return;
      for (const id of songIds) {
        if (!sl.songs.some(e => e.id === id)) sl.songs.push({ id, capo: null, transpose: 0 });
      }
      sl.updated_at = new Date().toISOString();
      safeStorageSet('sn_setlists', JSON.stringify(setlists));
      toast('Added to "' + sl.name + '"');
      close();
      exitMultiSelectMode();
    });
  });

  const newBtn = $('ms-new-setlist');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      close();
      showBulkAddToSetlistSheet(songIds);
    });
  }
}

function setupEvents() {
  $('back-to-folders').addEventListener('click', popView);
  $('back-to-songs').addEventListener('click', () => saveCurrentSongAndGoBack());

  // Quick song switcher
  $('prev-song-btn')?.addEventListener('click', prevSong);
  $('next-song-btn')?.addEventListener('click', nextSong);

  // Swipe to switch songs in editor
  (function initEditorSwipe() {
    const target = $('song-body');
    if (!target) return;
    const editorView = $('editor-view');
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let isSwipe = false;
    let currentDx = 0;
    let indicatorEl = null;
    const MIN_SWIPE_X = 60;   // min horizontal px to trigger
    const MAX_SWIPE_Y = 40;   // max vertical px deviation allowed
    const MAX_DURATION = 500; // ms — must be a quick flick

    function createIndicator() {
      if (indicatorEl) return indicatorEl;
      indicatorEl = document.createElement('div');
      indicatorEl.className = 'editor-swipe-indicator';
      indicatorEl.innerHTML = '<div class="editor-swipe-indicator-arrow"></div><div class="editor-swipe-indicator-label"></div>';
      document.body.appendChild(indicatorEl);
      return indicatorEl;
    }

    function removeIndicator() {
      if (indicatorEl) {
        indicatorEl.remove();
        indicatorEl = null;
      }
    }

    function updateSwipeFeedback(dx) {
      if (!editorView) return;
      // Apply resistance curve: raw dx is dampened past the threshold
      const dampened = dx * 0.4;
      editorView.style.transition = 'none';
      editorView.style.transform = `translateX(${dampened}px)`;

      const el = createIndicator();
      const isLeft = dx < 0;
      const progress = Math.min(Math.abs(dx) / MIN_SWIPE_X, 1);
      const willTrigger = progress >= 1;

      el.className = `editor-swipe-indicator ${isLeft ? 'swipe-left' : 'swipe-right'} ${willTrigger ? 'ready' : ''}`;
      el.style.opacity = String(0.3 + progress * 0.7);

      const label = el.querySelector('.editor-swipe-indicator-label');
      const arrow = el.querySelector('.editor-swipe-indicator-arrow');
      if (isLeft) {
        label.textContent = willTrigger ? 'Release for next ›' : 'Swipe for next ›';
        arrow.textContent = '‹';
      } else {
        label.textContent = willTrigger ? '‹ Release for prev' : '‹ Swipe for prev';
        arrow.textContent = '›';
      }

      // Scale the arrow toward the threshold
      const arrowScale = 1 + progress * 0.3;
      arrow.style.transform = `translateY(-50%) scale(${arrowScale})`;
    }

    function resetSwipeFeedback() {
      if (!editorView) return;
      editorView.style.transition = 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)';
      editorView.style.transform = '';
      removeIndicator();
    }

    target.addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      isSwipe = false;
      currentDx = 0;
    }, { passive: true });

    target.addEventListener('touchmove', e => {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);

      if (!isSwipe) {
        // Lock in as horizontal swipe if clearly horizontal
        if (dx > 15 && dx > dy * 1.2) {
          isSwipe = true;
          // Prevent vertical scroll while swiping horizontally
          // (passive:false not needed here since we just track)
        } else {
          return;
        }
      }

      // Real-time feedback
      currentDx = e.touches[0].clientX - touchStartX;
      // Reject if vertical deviation too large
      if (dy > MAX_SWIPE_Y * 2) {
        isSwipe = false;
        resetSwipeFeedback();
        return;
      }
      updateSwipeFeedback(currentDx);
    }, { passive: true });

    target.addEventListener('touchend', e => {
      if (!isSwipe) { resetSwipeFeedback(); return; }
      const elapsed = Date.now() - touchStartTime;
      if (elapsed > MAX_DURATION) { isSwipe = false; resetSwipeFeedback(); return; }

      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - touchStartX;
      const dy = Math.abs(endY - touchStartY);

      if (Math.abs(dx) >= MIN_SWIPE_X && dy <= MAX_SWIPE_Y) {
        // Haptic feedback
        haptic(15);
        // Animate out with a full slide before switching
        if (editorView) {
          editorView.style.transition = 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease';
          editorView.style.transform = dx < 0 ? 'translateX(-100%)' : 'translateX(100%)';
          editorView.style.opacity = '0';
        }
        removeIndicator();
        setTimeout(() => {
          if (dx < 0) {
            nextSong();
          } else {
            prevSong();
          }
        }, 200);
      } else {
        resetSwipeFeedback();
      }
      isSwipe = false;
    }, { passive: true });

    // Reset on touchcancel (e.g. system gesture intercept)
    target.addEventListener('touchcancel', () => {
      isSwipe = false;
      resetSwipeFeedback();
    }, { passive: true });
  })();

  // Key+BPM badge tap → show quick key/BPM action sheet
  $('editor-key-bpm')?.addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return;
    showKeyBpmSheet(song);
  });

  function saveCurrentSongAndGoBack() {
    const song = getSong(currentSongId);
    if (song) {
      // Flush pending auto-save to capture latest edits
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
      song.title = $('song-title').value || 'Untitled';
      song.updated_at = new Date().toISOString();
      saveSingleSong(song);
      hasChanges = false;
      if ($('save-btn')) $('save-btn').disabled = true;
      updateSaveDot('saved');
    }
    stopSessionTimer();
    if (isMetroPlaying()) metroStop();
    if (tunerActive) stopTuner();
    clearSaveStatusTimers();
    clearSectionLabel();
    popView(); renderSongList();
  }

  $('new-folder-btn').addEventListener('click', () => {
    showInputSheet({
      title: 'New Folder',
      placeholder: 'Folder name',
      onConfirm: (name) => {
        folders.push(name); persistFolders(); renderFolders();
      }
    });
  });

  $('new-song-btn').addEventListener('click', () => {
    showNewSongMenu();
  });

  // Auto-save on title input
  $('song-title').addEventListener('input', () => {
    const song = getSong(currentSongId);
    if (song) triggerAutoSave(song);
  });

  // Debounced search: avoid rebuilding DOM on every keystroke
  let searchTimer = 0;
  const searchInput = $('search-input');
  const searchClearBtn = $('search-clear-btn');

  function updateClearBtn() {
    if (searchClearBtn) searchClearBtn.style.display = searchInput.value ? 'flex' : 'none';
  }

  searchInput.addEventListener('input', e => {
    clearTimeout(searchTimer);
    updateClearBtn();
    searchTimer = setTimeout(() => renderSongList(e.target.value), 150);
  });

  // Handle the browser's native clear (X) in search input
  searchInput.addEventListener('search', () => {
    updateClearBtn();
  });

  if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
      searchInput.value = '';
      updateClearBtn();
      renderSongList('');
      searchInput.focus();
    });
  }

  // Sort button
  $('sort-btn').addEventListener('click', e => {
    e.stopPropagation();
    showSortPopover(e.currentTarget);
  });

  // Setlist nav button
  $('setlist-nav-btn')?.addEventListener('click', () => {
    showSetlistView();
  });

  // Save / Done button
  $('save-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return;
    pushVersion();
    song.title = $('song-title').value || 'Untitled';
    song.updated_at = new Date().toISOString();
    saveSingleSong(song);
    hasChanges = false;
    $('save-btn').disabled = true;
    toast('Saved');
  });

  // Undo button
  $('undo-btn').addEventListener('click', undoVersion);

  // Focus mode button
  $('focus-btn')?.addEventListener('click', () => {
    toggleFocusMode();
    // Re-apply toolbar visibility state after toolbar auto-hide logic
    setTimeout(() => {
      if (focusMode) {
        const toolbar = $('mobile-toolbar');
        const fab = $('toolbar-fab');
        if (toolbar) toolbar.style.display = 'none';
        if (fab) fab.style.display = 'none';
      }
    }, 50);
  });

  // Display mode button
  const displayModeBtn = $('display-mode-btn');
  if (displayModeBtn) {
    displayModeBtn.addEventListener('click', () => {
      cycleDisplayMode();
      const icons = { both: '≡', lyrics: '♫', chords: '𝄞' };
      const titles = { both: 'Display: Chords + Lyrics', lyrics: 'Display: Lyrics Only', chords: 'Display: Chords Only' };
      displayModeBtn.textContent = icons[displayMode];
      displayModeBtn.title = titles[displayMode];
      displayModeBtn.setAttribute('aria-label', titles[displayMode]);
    });
    // Set initial icon/title
    const initIcons = { both: '≡', lyrics: '♫', chords: '𝄞' };
    const initTitles = { both: 'Display: Chords + Lyrics', lyrics: 'Display: Lyrics Only', chords: 'Display: Chords Only' };
    displayModeBtn.textContent = initIcons[displayMode];
    displayModeBtn.title = initTitles[displayMode];
  }

  // Font size buttons
  const fontDecBtn = $('font-dec-btn');
  const fontIncBtn = $('font-inc-btn');
  if (fontDecBtn) fontDecBtn.addEventListener('click', () => adjustFontSize(-1));
  if (fontIncBtn) fontIncBtn.addEventListener('click', () => adjustFontSize(1));

  // ===== Section Navigation =====
  const sectionNavBtn = $('section-nav-btn');
  const sectionNavDropdown = $('section-nav-dropdown');
  const sectionNavList = $('section-nav-list');
  const sectionNavClose = $('section-nav-close');

  // Toggle section nav dropdown
  if (sectionNavBtn) {
    sectionNavBtn.addEventListener('click', () => {
      if (sectionNavDropdown.style.display === 'none') {
        openSectionNav();
      } else {
        closeSectionNav();
      }
    });
  }

  // Close button
  if (sectionNavClose) {
    sectionNavClose.addEventListener('click', closeSectionNav);
  }

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (sectionNavDropdown && sectionNavDropdown.style.display !== 'none') {
      if (!sectionNavDropdown.contains(e.target) && e.target !== sectionNavBtn) {
        closeSectionNav();
      }
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSectionNav();
  });

  function openSectionNav() {
    const song = getSong(currentSongId);
    if (!song || !song.sections) { closeSectionNav(); return; }
    const sections = song.sections;
    if (sections.length < 3) { closeSectionNav(); return; }

    // Build section list
    if (!sections.length) {
      sectionNavList.innerHTML = '<div class="section-nav-empty">No sections</div>';
    } else {
      sectionNavList.innerHTML = '';
      sections.forEach((sec, idx) => {
        const item = document.createElement('div');
        item.className = 'section-nav-item';
        item.dataset.sectionIdx = idx;
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '0');
        item.innerHTML = `<span class="section-nav-idx">${idx + 1}</span><span class="section-nav-name">${esc(sec.type || 'Section')}</span>`;
        // Scroll to section on click/tap
        item.addEventListener('click', () => {
          scrollToSection(idx);
          highlightNavItem(idx);
          closeSectionNav();
        });
        // Keyboard: Enter/Space to activate
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrollToSection(idx); highlightNavItem(idx); closeSectionNav(); }
        });
        sectionNavList.appendChild(item);
      });
    }

    // Highlight current
    const currentIdx = getCurrentVisibleSection();
    if (currentIdx >= 0) highlightNavItem(currentIdx);

    sectionNavDropdown.style.display = 'flex';
    if (sectionNavBtn) sectionNavBtn.classList.add('nav-btn-active');
  }

  function closeSectionNav() {
    if (sectionNavDropdown) sectionNavDropdown.style.display = 'none';
    if (sectionNavBtn) sectionNavBtn.classList.remove('nav-btn-active');
  }

  function highlightNavItem(idx) {
    if (!sectionNavList) return;
    const items = sectionNavList.querySelectorAll('.section-nav-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    // Scroll the active item into view within the dropdown
    const active = items[idx];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // Clear the persistent section breadcrumb label
  function clearSectionLabel() {
    const lbl = $('current-section-label');
    if (lbl) { lbl.textContent = ''; lbl.classList.remove('visible'); }
  }

  // Determine which section is currently most visible in the editor body
  function getCurrentVisibleSection() {
    const editorBody = $('song-body');
    if (!editorBody) return -1;
    const sections = editorBody.querySelectorAll('.song-section, .section-placeholder');
    if (!sections.length) return -1;
    const bodyRect = editorBody.getBoundingClientRect();
    const bodyCenter = bodyRect.top + bodyRect.height / 2;
    let closest = 0;
    let closestDist = Infinity;
    sections.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const elCenter = r.top + r.height / 2;
      const dist = Math.abs(elCenter - bodyCenter);
      if (dist < closestDist) { closestDist = dist; closest = parseInt(el.dataset.sectionIdx) || i; }
    });
    return closest;
  }

  // Editor scroll listener to highlight current section in the nav
  // and update the persistent section breadcrumb in the nav bar
  let _sectionScrollTick = null;
  const _songBody = $('song-body');
  const _sectionLabel = $('current-section-label');
  if (_songBody) {
    _songBody.addEventListener('scroll', () => {
      if (_sectionScrollTick) return;
      _sectionScrollTick = requestAnimationFrame(() => {
        _sectionScrollTick = null;
        const idx = getCurrentVisibleSection();
        if (idx >= 0) {
          // Highlight in dropdown if open
          if (sectionNavDropdown && sectionNavDropdown.style.display !== 'none') {
            highlightNavItem(idx);
          }
          // Update persistent section label in nav bar
          if (_sectionLabel) {
            const song = getSong(currentSongId);
            const sec = song && song.sections && song.sections[idx];
            if (sec) {
              _sectionLabel.textContent = (sec.type || 'Section') + ' ' + (idx + 1);
              _sectionLabel.classList.add('visible');
            }
          }
        } else if (_sectionLabel) {
          _sectionLabel.classList.remove('visible');
        }
      });
    }, { passive: true });
  }

  // ===== Scroll to Section =====
  function scrollToSection(idx) {
    const editorBody = $('song-body');
    if (!editorBody) return;
    // For lazy-rendered songs, the section might be a placeholder — force render it first
    const sectionEl = editorBody.querySelector(`.song-section[data-section-idx="${idx}"], .section-placeholder[data-section-idx="${idx}"]`);
    if (sectionEl) {
      // If it's a placeholder, we need to render the actual section first
      if (sectionEl.classList.contains('section-placeholder') && typeof buildSectionElement === 'function') {
        const song = getSong(currentSongId);
        if (song && song.sections[idx]) {
          const realEl = buildSectionElement(song, idx, song.sections[idx]);
          sectionEl.replaceWith(realEl);
          // Also un-observe the old placeholder if observer exists
          if (sectionObserver) { try { sectionObserver.unobserve(sectionEl); } catch {} }
          realEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
      sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Recording
  $('record-btn').addEventListener('click', async () => {
    if (isRecording) { stopRecording(); return; }
    if (!getSong(currentSongId)) { toast('Open a song first'); return; }
    pushVersion();
    await startRecording();
  });

  $('recordings-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleRecordingsDropdown(); });
  $('close-hist').addEventListener('click', () => $('history-panel').style.display = 'none');

  // Add section — show type picker
  $('add-section-btn').addEventListener('click', (e) => {
    showSectionPicker(e);
  });

  // Transpose
  $('transpose-down-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return; pushVersion();
    const oldKey = song.key || '—';
    transposeSong(song, -1); saveSingleSong(song); renderEditorBody(song); updateEditorKeyBpm(song);
    toast(`${oldKey} → ${song.key || '—'}`);
  });
  $('transpose-up-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return; pushVersion();
    const oldKey = song.key || '—';
    transposeSong(song, 1); saveSingleSong(song); renderEditorBody(song); updateEditorKeyBpm(song);
    toast(`${oldKey} → ${song.key || '—'}`);
  });

  // More menu — bottom sheet
  $('toolbar-more-btn').addEventListener('click', e => {
    e.stopPropagation();
    showToolbarSheet();
  });

  // Toolbar bottom sheet actions
  document.querySelectorAll('.toolbar-sheet-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      hideToolbarSheet();
      haptic(15);
      const a = btn.dataset.action;
      const song = getSong(currentSongId);

      if (a === 'set-key') {
        if (!song) return;
        showKeyPicker(song);
      } else if (a === 'set-bpm') {
        if (!song) return;
        showInputSheet({
          title: 'Set BPM',
          placeholder: 'e.g. 120',
          initialValue: song.bpm ? String(song.bpm) : '',
          onConfirm: (bpm) => {
            song.bpm = parseInt(bpm) || null; saveSingleSong(song);
            updateEditorKeyBpm(song);
          }
        });
      } else if (a === 'import-txt') {
        importFiles();
      } else if (a === 'export-all') {
        hideToolbarSheet();
        exportAllSongs();
      } else if (a === 'import-backup') {
        hideToolbarSheet();
        importBackup();
      } else if (a === 'export-txt') {
        if (!song) return; downloadFile(buildExportText(song), `${song.title || 'song'}.txt`, 'text/plain'); toast('Exported');
      } else if (a === 'export-md') {
        if (!song) return; downloadFile(buildExportMarkdown(song), `${song.title || 'song'}.md`, 'text/markdown'); toast('Exported');
      } else if (a === 'export-clip') {
        if (!song) return; navigator.clipboard.writeText(buildExportText(song)).then(() => toast('Copied')).catch(() => toast('Unable to copy to clipboard', 'error'));
      } else if (a === 'history') {
        const panel = $('history-panel');
        if (panel) panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
      } else if (a === 'delete') {
        if (!song) return;
        showConfirmSheet({
          title: 'Delete Song',
          body: `Delete "${song.title}"?`,
          confirmText: 'Delete',
          onConfirm: async () => {
            stopSessionTimer();
            await deleteSong(currentSongId); currentSongId = null; popView(); renderSongList(); toast('Deleted');
          }
        });
      } else if (a === 'transpose') {
        const song = getSong(currentSongId);
        if (song) showKeyPicker(song);
      } else if (a === 'setlist') {
        showSetlistView();
      } else if (a === 'share-song') {
        showShareSheet();
      } else if (a === 'plugins') {
        showPluginSheet();
      } else if (a === 'metronome') {
        showMetronomePanel();
      } else if (a === 'tuner') {
        showTunerPanel();
      } else if (a === 'song-stats') {
        showSongStatsPanel();
      } else if (a === 'edit-tags') {
        showTagEditorPanel();
      } else if (a === 'duplicate-song') {
        duplicateCurrentSong();
      } else if (a === 'theme-toggle') {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        safeStorageSet('sn_app_theme', next);
      } else if (a === 'print-song') {
        hideToolbarSheet();
        showSongPrintPreview();
      } else if (a === 'info') {
        showSongNotesPanel();
      } else if (a === 'display-mode') {
        cycleDisplayMode();
        const dmb = $('display-mode-btn');
        if (dmb) {
          const icons = { both: '≡', lyrics: '♫', chords: '𝄞' };
          const titles = { both: 'Display: Chords + Lyrics', lyrics: 'Display: Lyrics Only', chords: 'Display: Chords Only' };
          dmb.textContent = icons[displayMode];
          dmb.title = titles[displayMode];
          dmb.setAttribute('aria-label', titles[displayMode]);
        }
      } else if (a === 'typewriter-scroll') {
        typewriterScroll = !typewriterScroll;
        safeStorageSet('sn_typewriterScroll', typewriterScroll);
        btn.classList.toggle('sheet-active', typewriterScroll);
        toast(typewriterScroll ? 'Typewriter scroll on' : 'Typewriter scroll off');
      } else if (a === 'clear-chords') {
        if (!song) return;
        clearAllChords();
      }
    });
  });

  // Close sheet on backdrop tap
  document.querySelector('.toolbar-sheet-backdrop')?.addEventListener('click', hideToolbarSheet);

  // ===== Metronome Events =====

  // Play/stop
  $('metro-play-btn')?.addEventListener('click', () => {
    if (isMetroPlaying()) metroStop(); else metroStart();
  });

  // BPM up/down
  $('metro-bpm-down')?.addEventListener('click', () => metroSetBpm(getMetroBpm() - 1));
  $('metro-bpm-up')?.addEventListener('click', () => metroSetBpm(getMetroBpm() + 1));

  // BPM slider
  $('metro-bpm-slider')?.addEventListener('input', e => {
    metroSetBpm(parseInt(e.target.value));
  });

  // Time signature buttons
  document.querySelectorAll('.metro-time-btn').forEach(btn => {
    btn.addEventListener('click', () => metroSetTimeSig(parseInt(btn.dataset.sig)));
  });

  // Tempo preset buttons
  document.querySelectorAll('.metro-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => metroSetBpm(parseInt(btn.dataset.bpm)));
  });

  // Tap tempo button
  const tapBtn = $('metro-tap-btn');
  if (tapBtn) {
    tapBtn.addEventListener('click', handleTapTempo);
    tapBtn.addEventListener('touchend', e => { e.preventDefault(); handleTapTempo(); });
  }

  // ===== Tuner Events =====

  // Start/stop tuner
  $('tuner-start-btn')?.addEventListener('click', () => {
    if (tunerActive) { stopTuner(); } else { startTuner(); }
  });

  // String selector buttons
  document.querySelectorAll('.tuner-string-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tuner-string-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      tunerTargetNote = btn.dataset.note;
      updateTunerTargetDisplay();
      haptic(10);
    });
  });

  // Tuning preset buttons
  document.querySelectorAll('.tuner-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const presetKey = btn.dataset.preset;
      if (presetKey && presetKey !== activeTuningPreset) {
        applyTuningPreset(presetKey);
        haptic(15);
      }
    });
  });

  // ===== Setlist Events =====

  // Setlist button in toolbar sheet
  document.querySelectorAll('.toolbar-sheet-btn[data-action="setlist"]').forEach(btn => {
    btn.addEventListener('click', () => {
      hideToolbarSheet();
      showSetlistView();
    });
  });

  // Chord Diagram button in toolbar sheet
  document.querySelectorAll('.toolbar-sheet-btn[data-action="chord-diagram"]').forEach(btn => {
    btn.addEventListener('click', () => {
      hideToolbarSheet();
      // If a chord is currently being edited, show that chord; otherwise default to C
      const currentChordName = document.querySelector('.chord-sheet-display')?.textContent || 'C';
      showChordDiagramPanel(currentChordName !== '?' ? currentChordName : 'C');
    });
  });

  // Back from setlist view
  $('back-from-setlist')?.addEventListener('click', popView);

  // New setlist
  $('setlist-new-btn')?.addEventListener('click', createNewSetlist);

  // Back from setlist detail
  $('back-from-setlist-detail')?.addEventListener('click', () => {
    renderSetlistList();
    popView();
  });

  // Add song to setlist
  $('setlist-add-song-btn')?.addEventListener('click', () => {
    const setlist = setlists.find(s => s.id === activeSetlistId);
    if (!setlist) { toast('Create a setlist first'); return; }
    showSongPicker();
  });

  // Transpose all in setlist
  $('setlist-transpose-btn')?.addEventListener('click', () => {
    const setlist = setlists.find(s => s.id === activeSetlistId);
    if (!setlist) return;
    showTransposeSheet();
  });

  // Print setlist chord charts
  $('setlist-print-btn')?.addEventListener('click', () => {
    showSetlistPrintPreview();
  });

  // Print preview controls
  $('print-close-btn')?.addEventListener('click', () => {
    $('setlist-print-overlay').style.display = 'none';
  });
  $('print-do-btn')?.addEventListener('click', () => {
    window.print();
  });

  // FAB to show toolbar
  $('toolbar-fab')?.addEventListener('click', () => {
    haptic(15);
    const toolbar = $('mobile-toolbar');
    if (toolbar) {
      toolbar.classList.remove('collapsed');
      $('toolbar-fab').classList.add('hidden');
      setTimeout(() => { $('toolbar-fab').style.display = 'none'; $('toolbar-fab').classList.remove('hidden'); }, 300);
    }
  });

  // Auto-collapse toolbar on scroll down, show on scroll up
  let lastScrollTop = 0;
  let scrollTimeout = null;
  const editorBody = $('song-body');
  if (editorBody) {
    editorBody.addEventListener('scroll', () => {
      const scrollTop = editorBody.scrollTop;
      const toolbar = $('mobile-toolbar');
      const fab = $('toolbar-fab');
      if (!toolbar || !fab) return;

      if (scrollTop > lastScrollTop && scrollTop > 100) {
        // Scrolling down — collapse toolbar
        toolbar.classList.add('collapsed');
        fab.style.display = 'flex';
      } else {
        // Scrolling up — show toolbar
        toolbar.classList.remove('collapsed');
        fab.style.display = 'none';
      }
      lastScrollTop = scrollTop;

      // Show toolbar briefly after scroll stops
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        toolbar.classList.remove('collapsed');
      }, 1500);
    }, { passive: true });
  }

  // ===== Pull-to-Refresh on Song List =====
  (function initPullToRefresh() {
    const view = $('song-list-view');
    const list = $('song-list');
    const indicator = $('pull-indicator');
    if (!view || !list || !indicator) return;

    let pullStartY = 0;
    let pullDistance = 0;
    let isPulling = false;
    let isRefreshing = false;
    const threshold = 70; // px to trigger refresh
    const maxPull = 100;  // max px to stretch

    // Touch start
    list.addEventListener('touchstart', e => {
      if (list.scrollTop > 5 || isRefreshing) return; // only at top
      pullStartY = e.touches[0].clientY;
      isPulling = true;
      pullDistance = 0;
    }, { passive: true });

    // Touch move
    list.addEventListener('touchmove', e => {
      if (!isPulling || isRefreshing) return;
      const currentY = e.touches[0].clientY;
      pullDistance = Math.min(maxPull, Math.max(0, currentY - pullStartY));

      if (pullDistance > 0) {
        e.preventDefault(); // stop scroll bounce while pulling
        indicator.style.height = pullDistance + 'px';
        indicator.style.opacity = Math.min(1, pullDistance / threshold);

        if (pullDistance >= threshold) {
          indicator.classList.add('visible');
          indicator.classList.remove('refreshing');
        } else {
          indicator.classList.remove('visible', 'refreshing');
        }
      }
    }, { passive: false });

    // Touch end
    list.addEventListener('touchend', () => {
      if (!isPulling) return;
      isPulling = false;

      if (pullDistance >= threshold && !isRefreshing) {
        // Trigger refresh
        isRefreshing = true;
        indicator.classList.remove('visible');
        indicator.classList.add('refreshing');
        indicator.style.height = '56px';
        indicator.style.opacity = '1';

        refreshSongData().then(() => {
          isRefreshing = false;
          indicator.classList.remove('refreshing', 'visible');
          indicator.style.height = '0';
          indicator.style.opacity = '0';
          toast('Refreshed', 'success');
        });
      } else {
        // Snap back
        indicator.classList.remove('visible', 'refreshing');
        indicator.style.height = '0';
        indicator.style.opacity = '0';
      }
      pullDistance = 0;
    }, { passive: true });
  })();

  function showToolbarSheet() {
    const sheet = $('toolbar-sheet');
    if (sheet) {
      sheet.style.display = 'flex';
      // Sync toggle button states
      const twBtn = sheet.querySelector('[data-action="typewriter-scroll"]');
      if (twBtn) twBtn.classList.toggle('sheet-active', typewriterScroll);
    }
  }
  function hideToolbarSheet() {
    const sheet = $('toolbar-sheet');
    if (sheet) sheet.style.display = 'none';
  }

  // More menu (legacy — keep for backward compat)
  $('more-menu')?.querySelectorAll('button')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      $('more-menu').style.display = 'none';
      // Handled by sheet buttons now
    });
  });

  // Close popovers on bg tap
  document.addEventListener('click', e => {
    if (!e.target.closest('.popover') && !e.target.closest('#toolbar-more-btn') && !e.target.closest('#recordings-btn') && !e.target.closest('#record-btn')) {
      document.querySelectorAll('.popover').forEach(m => m.style.display = 'none');
    }
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoVersion(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        if (typeof showNewSongMenu === 'function') showNewSongMenu();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault(); const song = getSong(currentSongId);
      if (song) { pushVersion(); song.title = $('song-title').value || 'Untitled'; song.updated_at = new Date().toISOString(); saveSingleSong(song); toast('Saved'); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        if (typeof showSongPrintPreview === 'function') showSongPrintPreview();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); showShortcuts(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        toggleFindBar();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
      // Ctrl+L focuses the song list search bar (when in song list view)
      e.preventDefault();
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        if (viewStack[viewStack.length - 1] === 'song-list-view') {
          const searchInput = $('search-input');
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          }
        }
      }
    }
    if (e.key === 'Escape' && $('find-bar').style.display !== 'none') {
      hideFindBar();
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Only trigger ? when not focused on an input/textarea
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault(); showShortcuts();
      }
    }
    if (e.key === 'Escape' && $('shortcuts-overlay').style.display !== 'none') {
      hideShortcuts();
    }
    // Arrow key song navigation (only when not in an input and editor is visible)
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        if (viewStack[viewStack.length - 1] === 'editor-view') {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prevSong(); }
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextSong(); }
        }
      }
    }
  });

  // ===== Listbox Keyboard Navigation =====
  // Arrow-key + Enter/Space navigation for folder-list and song-list
  function setupListKeyboardNav(listboxId, itemSelector) {
    const listbox = $(listboxId);
    if (!listbox) return;

    // Make the listbox itself programmatically focusable for roving tabindex
    if (!listbox.hasAttribute('tabindex')) listbox.setAttribute('tabindex', '0');

    function getItems() {
      return [...listbox.querySelectorAll(itemSelector)].filter(el => el.offsetParent !== null);
    }

    function getFocusedIdx(items) {
      const focused = listbox.querySelector(`${itemSelector}.keyboard-focus`);
      return focused ? items.indexOf(focused) : -1;
    }

    function focusItem(items, idx) {
      // Remove previous focus
      listbox.querySelectorAll(`${itemSelector}.keyboard-focus`).forEach(el => el.classList.remove('keyboard-focus'));
      if (idx < 0 || idx >= items.length) return;
      const el = items[idx];
      el.classList.add('keyboard-focus');
      el.scrollIntoView({ block: 'nearest' });
    }

    listbox.addEventListener('keydown', e => {
      // Skip if user is typing in an input/textarea/contenteditable
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.target.isContentEditable) return;
      // Skip buttons inside the listbox (they handle their own keys)
      if (e.target.closest('button')) return;

      const items = getItems();
      if (!items.length) return;

      const focusedIdx = getFocusedIdx(items);
      let newIdx = focusedIdx;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        newIdx = (focusedIdx + 1) % items.length;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        newIdx = focusedIdx <= 0 ? items.length - 1 : focusedIdx - 1;
      } else if (e.key === 'Home' || e.key === 'PageUp') {
        e.preventDefault();
        newIdx = 0;
      } else if (e.key === 'End' || e.key === 'PageDown') {
        e.preventDefault();
        newIdx = items.length - 1;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focusedIdx >= 0 && focusedIdx < items.length) {
          items[focusedIdx].click();
        } else if (items.length) {
          items[0].click();
        }
        return;
      } else if (e.key === 'Escape') {
        // Remove keyboard focus highlight, return focus to listbox
        listbox.querySelectorAll(`${itemSelector}.keyboard-focus`).forEach(el => el.classList.remove('keyboard-focus'));
        return;
      } else {
        return; // Don't handle other keys
      }

      if (newIdx !== focusedIdx || focusedIdx === -1) {
        focusItem(items, newIdx);
      }
    });

    // Remove keyboard-focus when mouse clicks an item
    listbox.addEventListener('mousedown', () => {
      listbox.querySelectorAll(`${itemSelector}.keyboard-focus`).forEach(el => el.classList.remove('keyboard-focus'));
    });
    listbox.addEventListener('pointerdown', () => {
      listbox.querySelectorAll(`${itemSelector}.keyboard-focus`).forEach(el => el.classList.remove('keyboard-focus'));
    });
  }

  // Wire up folder list and song list
  setupListKeyboardNav('folder-list', '.list-item');
  // Song list items need the data-id attribute (real rendered rows, not section headers)
  setupListKeyboardNav('song-list', '.list-item[data-id], .swipe-item[data-id]');
  // Also cover the setlist list and gallery cards
  setupListKeyboardNav('setlist-list', '.list-item');
  setupListKeyboardNav('setlist-songs', '.list-item');

  // Mobile keyboard handling
  initMobileKeyboard();

  setupFolderActions();
  
  // Theme toggle (now in toolbar sheet — this handler is for backward compat)
  const oldThemeBtn = $('theme-toggle');
  if (oldThemeBtn) {
    oldThemeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      safeStorageSet('sn_app_theme', next);
    });
  }
  
  // Info panel toggle (now in toolbar sheet — this handler is for backward compat)
  const oldInfoBtn = $('info-btn');
  if (oldInfoBtn) {
    oldInfoBtn.addEventListener('click', () => {
      const bar = $('info-bar');
      if (bar.style.display === 'none' || !bar.style.display) {
        updateInfoBar();
        bar.style.display = 'flex';
      } else {
        bar.style.display = 'none';
      }
    });
  }
  
  // View toggle (list / gallery)
  const songListEl = $('song-list');
  const viewToggleEl = $('view-toggle');
  if (songListEl && galleryMode) {
    songListEl.classList.add('gallery');
    if (viewToggleEl) viewToggleEl.textContent = '▦';
  }
  viewToggleEl?.addEventListener('click', () => {
    galleryMode = !galleryMode;
    const list = $('song-list');
    list.classList.toggle('gallery', galleryMode);
    viewToggleEl.textContent = galleryMode ? '▦' : '⊞';
    safeStorageSet('sn_gallery_mode', galleryMode);
    // Re-render so gallery cards get proper markup
    renderSongList($('search-input')?.value || '');
  });

  // Tag editor events
  setupTagEditorEvents();

  // Edge-swipe-to-go-back gesture
  // Swipe right from left edge (within 40px) to navigate back on song-list and editor views
  (function initEdgeSwipeBack() {
    const EDGE_THRESHOLD = 40;   // px from left edge to activate
    const SWIPE_MIN_DIST = 60;   // px horizontal travel to trigger back
    let startX = 0, startY = 0;
    let tracking = false;

    document.addEventListener('touchstart', e => {
      const view = viewStack[viewStack.length - 1];
      if (view === 'folder-view') return; // no back target
      const t = e.touches[0];
      if (t.clientX <= EDGE_THRESHOLD) {
        startX = t.clientX;
        startY = t.clientY;
        tracking = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Cancel if user swipes vertically more than horizontal (scrolling content)
      if (Math.abs(dy) > Math.abs(dx) * 0.8) {
        tracking = false;
      }
    }, { passive: true });

    document.addEventListener('touchend', e => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dx >= SWIPE_MIN_DIST && Math.abs(dy) < Math.abs(dx) * 0.8) {
        popView();
        haptic(15);
      }
    }, { passive: true });
  })();

  // Double-tap editor nav bar title to scroll editor to top
  (function initNavTitleScrollTop() {
    const navTitleWrap = document.querySelector('.editor-nav .nav-title-wrap');
    const songBody = $('song-body');
    if (!navTitleWrap || !songBody) return;
    let lastTap = 0;
    navTitleWrap.addEventListener('touchend', () => {
      const now = Date.now();
      if (now - lastTap < 350) {
        songBody.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
      }
      lastTap = now;
    }, { passive: true });
    // Also support double-click on desktop
    navTitleWrap.addEventListener('dblclick', () => {
      songBody.scrollTo({ top: 0, behavior: 'smooth' });
    });
  })();
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#f2f2f7');
}

function updateInfoBar() {
  const bar = $('info-bar');
  const song = getSong(currentSongId);
  if (!bar || !song) return;
  
  let wordCount = 0, lineCount = 0, chordCount = 0;
  song.sections?.forEach(sec => {
    sec.lines?.forEach(l => {
      if (l.text) {
        wordCount += l.text.split(/\s+/).filter(Boolean).length;
        lineCount++;
      }
      chordCount += l.chords?.length || 0;
    });
  });
  
  const created = song.created_at ? new Date(song.created_at).toLocaleDateString() : '—';
  const updated = song.updated_at ? fmtDate(song.updated_at) : '—';
  
  bar.innerHTML = `<span>${lineCount} lines · ${wordCount} words · ${chordCount} chords</span><span>Created ${created} · Modified ${updated}</span}`;
};

// ===== Song Notes / Memo Panel =====
function showSongNotesPanel() {
  const song = getSong(currentSongId);
  if (!song) return;

  // Remove existing panel
  const existing = $('song-notes-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'song-notes-panel';
  panel.className = 'song-notes-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Song Info');
  panel.setAttribute('aria-modal', 'true');

  const notesVal = song.notes || '';
  panel.innerHTML = `
    <div class="song-notes-backdrop"></div>
    <div class="song-notes-content">
      <div class="toolbar-sheet-handle"></div>
      <div class="song-notes-header">
        <h3 class="song-notes-title">Song Info</h3>
      </div>
      <div class="song-notes-body">
        <div class="song-notes-stats" id="song-notes-stats"></div>
        <div class="song-notes-divider"></div>
        <div class="song-notes-label">Notes</div>
        <textarea class="song-notes-textarea" id="song-notes-textarea" placeholder="Add ideas, reminders, co-writer credits, recording notes…" spellcheck="true" aria-label="Song notes">${escHtml(notesVal)}</textarea>
        <div class="song-notes-footer">
          <span class="song-notes-save-hint" id="song-notes-save-hint"></span>
        </div>
      </div>
    </div>`;

  document.body.appendChild(panel);

  enableDragToDismiss(panel, { contentSelector: '.song-notes-content', backdropSelector: '.song-notes-backdrop' });

  const close = () => {
    saveNotesFromPanel(panel, song);
    panel.remove();
  };

  panel.querySelector('.song-notes-backdrop').onclick = close;

  // Populate stats
  updateNotesStats(song);

  // Auto-save notes on input with debounce
  const textarea = panel.querySelector('#song-notes-textarea');
  const hint = panel.querySelector('#song-notes-save-hint');
  let notesTimer = null;

  textarea.addEventListener('input', () => {
    if (notesTimer) clearTimeout(notesTimer);
    hint.textContent = 'Saving…';
    notesTimer = setTimeout(() => {
      if (!getSong(currentSongId)) return;
      song.notes = textarea.value;
      song.updated_at = new Date().toISOString();
      saveSingleSong(song);
      hint.textContent = 'Saved';
      updateInfoBar();
    }, 600);
  });

  // Also save on close via handleclick
  const origClose = close;
  panel.querySelector('.toolbar-sheet-handle').addEventListener('dblclick', origClose);
}

function saveNotesFromPanel(panel, song) {
  const textarea = panel.querySelector('#song-notes-textarea');
  if (textarea && song.notes !== textarea.value) {
    song.notes = textarea.value;
    song.updated_at = new Date().toISOString();
    saveSingleSong(song);
    updateInfoBar();
  }
}

function updateNotesStats(song) {
  const statsEl = $('song-notes-stats');
  if (!statsEl || !song) return;

  let wordCount = 0, lineCount = 0, chordCount = 0, sectionCount = 0;
  const chordSet = new Set();
  song.sections?.forEach(sec => {
    sectionCount++;
    sec.lines?.forEach(l => {
      if (l.text) {
        wordCount += l.text.split(/\s+/).filter(Boolean).length;
        lineCount++;
      }
      (l.chords || []).forEach(c => {
        chordCount++;
        chordSet.add(c.name);
      });
    });
  });

  const created = song.created_at ? new Date(song.created_at).toLocaleDateString() : '—';
  const updated = song.updated_at ? fmtDate(song.updated_at) : '—';
  const uniqueChords = Array.from(chordSet).sort();
  const tags = (song.tags || []).length > 0 ? song.tags.join(', ') : '—';
  const key = song.key || '—';
  const bpm = song.bpm ? `${song.bpm} BPM` : '—';
  const capo = (song.capo || 0) ? `Capo ${song.capo}` : '—';
  const totalMs = song.session_ms || 0;
  const sessionTime = totalMs > 0 ? formatSessionTime(totalMs + (sessionStartTime && currentSongId === song.id ? Date.now() - sessionStartTime : 0)) : '—';

  let html = '';
  html += `<div class="song-stat-row"><span class="song-stat-label">Key</span><span class="song-stat-value">${esc(key)}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">BPM</span><span class="song-stat-value">${esc(bpm)}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Capo</span><span class="song-stat-value">${esc(capo)}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Sections</span><span class="song-stat-value">${sectionCount}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Lines</span><span class="song-stat-value">${lineCount} · ${wordCount} words</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Chords</span><span class="song-stat-value">${chordCount} (${uniqueChords.length} unique)</span></div>`;
  if (uniqueChords.length > 0 && uniqueChords.length <= 12) {
    html += `<div class="song-stat-row"><span class="song-stat-label">Used</span><span class="song-stat-value">${esc(uniqueChords.join(' · '))}</span></div>`;
  }
  html += `<div class="song-stat-row"><span class="song-stat-label">Tags</span><span class="song-stat-value">${esc(tags)}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Created</span><span class="song-stat-value">${created}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Modified</span><span class="song-stat-value">${updated}</span></div>`;
  html += `<div class="song-stat-row"><span class="song-stat-label">Writing time</span><span class="song-stat-value">${esc(sessionTime)}</span></div>`;

  statsEl.innerHTML = html;
}

// ===== First-Run Onboarding =====
let onboardingCardIdx = 0;
const TOTAL_ONBOARDING_CARDS = 4;

function showOnboarding() {
  const el = $('onboarding');
  if (!el) return;
  el.style.display = 'flex';
  onboardingCardIdx = 0;
  updateOnboardingCards();
  // Trap focus inside onboarding
  setTimeout(() => {
    const nextBtn = $('onboarding-next');
    if (nextBtn) nextBtn.focus();
  }, 100);
}

function hideOnboarding() {
  const el = $('onboarding');
  if (!el) return;
  el.style.display = 'none';
  safeStorageSet('sn_onboarding_seen', 'true');
}

function updateOnboardingCards() {
  const track = $('onboarding-track');
  if (track) {
    track.style.transform = `translateX(-${onboardingCardIdx * 100}%)`;
  }
  // Update dots
  const dots = document.querySelectorAll('.onboarding-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === onboardingCardIdx);
    d.setAttribute('aria-selected', i === onboardingCardIdx ? 'true' : 'false');
  });
  // Update next button text
  const nextBtn = $('onboarding-next');
  if (nextBtn) {
    nextBtn.textContent = onboardingCardIdx === TOTAL_ONBOARDING_CARDS - 1 ? 'Get Started' : 'Next';
  }
}

function onboardingNext() {
  if (onboardingCardIdx < TOTAL_ONBOARDING_CARDS - 1) {
    onboardingCardIdx++;
    updateOnboardingCards();
  } else {
    hideOnboarding();
  }
}

function onboardingGoTo(idx) {
  if (idx >= 0 && idx < TOTAL_ONBOARDING_CARDS) {
    onboardingCardIdx = idx;
    updateOnboardingCards();
  }
}

// Wire onboarding events
document.addEventListener('DOMContentLoaded', () => {
  const nextBtn = $('onboarding-next');
  const skipBtn = $('onboarding-skip');
  const dots = document.querySelectorAll('.onboarding-dot');
  const track = $('onboarding-track');

  if (nextBtn) nextBtn.addEventListener('click', onboardingNext);
  if (skipBtn) skipBtn.addEventListener('click', hideOnboarding);
  dots.forEach(d => {
    d.addEventListener('click', () => onboardingGoTo(parseInt(d.dataset.idx)));
  });

  // Swipe support
  if (track) {
    let startX = 0, startY = 0, isSwiping = false;
    track.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isSwiping = true;
    }, { passive: true });
    track.addEventListener('touchend', e => {
      if (!isSwiping) return;
      isSwiping = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
        if (dx < 0) onboardingNext();
        else if (onboardingCardIdx > 0) onboardingGoTo(onboardingCardIdx - 1);
      }
    }, { passive: true });
  }
});

// Init
async function init() {
  // Set reduced-motion attribute on <html> for CSS targeting
  if (prefersReducedMotion) document.documentElement.setAttribute('data-reduced-motion', 'true');
  // Initialize modules
  metroInit($);
  // Show skeleton while loading data
  showSongListSkeletonStaggered(6);
  try {
    await initTauri();
    await loadSongs();
    purgeExpiredTrash();
  } catch (err) {
    console.error('Init failed:', err);
    showInitError(err);
    return;
  }

  // Restore theme — respect system preference on first launch
  const savedTheme = localStorage.getItem('sn_app_theme');
  const systemPrefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const theme = savedTheme || (systemPrefersLight ? 'light' : 'dark');
  applyTheme(theme);

  try { const s = JSON.parse(localStorage.getItem('folders_app')); if (s?.length) folders = s; } catch {}
  if (isTauri) { const bf = await tauriLoadFolders(); if (bf?.length) folders = bf; }

  // Restore sort mode
  const savedSort = localStorage.getItem('sn_app_sort');
  if (savedSort && ['recent', 'title-az', 'title-za', 'key'].includes(savedSort)) {
    activeSortMode = savedSort;
  }
  updateSortBtn();

  addSampleSongs();

  // Show first-run onboarding
  if (!localStorage.getItem('sn_onboarding_seen')) {
    showOnboarding();
  }

  // Remember last opened song
  const lastId = localStorage.getItem('songs_app_last');
  if (lastId && getSong(lastId)) {
    currentSongId = lastId;
  }
  
  renderFolders();
  setupEvents();
  initDragDrop();

  // Restore focus mode
  applyFocusMode();

  // Offline/online detection
  loadSyncQueueMeta();
  updateOfflineIndicator();
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
}

function showInitError(err) {
  const el = $('song-list');
  if (!el) return;
  const msg = err?.message || 'Something went wrong';
  el.innerHTML = `<div class="error-state">
    <div class="empty-icon">⚠️</div>
    <h2>Couldn't load songs</h2>
    <p>${esc(msg)}</p>
    <button class="error-retry-btn" id="error-retry-btn">Try Again</button>
  </div>`;
  el.querySelector('#error-retry-btn').addEventListener('click', () => {
    showSongListSkeletonStaggered(6);
    init();
  });
}

// Global error handler — last resort for uncaught errors
window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled promise rejection:', e.reason);
  if (e.reason instanceof Error) {
    toast(`Error: ${e.reason.message}`, 'error');
  } else {
    toast('An unexpected error occurred', 'error');
  }
});

window.addEventListener('error', e => {
  console.error('Global error:', e.error || e.message);
  toast('An unexpected error occurred', 'error');
  // Don't prevent default — let the browser log it too
});

// ===== Unsaved Changes Protection =====

// Emergency save — synchronous, best-effort persistence for page-close scenarios
function emergencySave() {
  const song = getSong(currentSongId);
  if (!song) return;
  song.title = $('song-title')?.value || 'Untitled';
  song.updated_at = new Date().toISOString();
  // Flush debounced save timer
  clearTimeout(autoSaveTimer);
  // Sync localStorage immediately (reliable in pagehide/visibilitychange)
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song; else songs.unshift(song);
  flushLocalStorage();
  // Persist to per-song key as redundant backup (survives full data corruption)
  safeStorageSet(`song_${song.id}`, JSON.stringify(song));
  hasChanges = false;
  if ($('save-btn')) $('save-btn').disabled = true;
  updateSaveDot('saved');
}

// Warn before closing/tab away when there are unsaved edits
window.addEventListener('beforeunload', e => {
  if (hasChanges) {
    emergencySave();
    // Standard beforeunload prompt — browser shows its own dialog
    e.preventDefault();
    return e.returnValue = '';
  }
});

// Auto-save when the page loses visibility (app backgrounded on mobile, tab switch, etc.)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause session timer — accumulate elapsed time into sessionTotalMs so
    // background time doesn't count as writing time.
    if (sessionStartTime) {
      sessionTotalMs += Date.now() - sessionStartTime;
      sessionStartTime = null;
    }
    if (hasChanges) {
      emergencySave();
    }
  } else {
    // Resume session timer — reset sessionStartTime so display picks up from here
    if (!sessionStartTime) {
      sessionStartTime = Date.now();
    }
  }
});

// pagehide fires in ALL page-exit scenarios — including mobile app kill/swipe-away
// where beforeunload does NOT fire. This is the last line of defense for data loss.
window.addEventListener('pagehide', () => {
  if (hasChanges) {
    emergencySave();
  }
});

// ===== Song Statistics =====

function extractAllChords(song) {
  const chords = [];
  if (!song || !song.sections) return chords;
  song.sections.forEach(sec => {
    (sec.lines || []).forEach(line => {
      (line.chords || []).forEach(c => {
        if (c.name && c.name.trim()) chords.push(c.name.trim());
      });
    });
  });
  return chords;
}

function countWords(song) {
  if (!song || !song.sections) return 0;
  let count = 0;
  song.sections.forEach(sec => {
    (sec.lines || []).forEach(line => {
      const words = (line.text || '').trim().split(/\s+/).filter(w => w.length > 0);
      count += words.length;
    });
  });
  return count;
}

function getChordFrequency(song) {
  const chords = extractAllChords(song);
  const freq = {};
  chords.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1]);
}

function getSectionBreakdown(song) {
  if (!song || !song.sections) return [];
  return song.sections.map(sec => ({
    type: sec.type || 'Unknown',
    lines: (sec.lines || []).length,
    chords: (sec.lines || []).reduce((a, l) => a + (l.chords || []).length, 0)
  }));
}

function getChordProgression(song) {
  const progression = [];
  if (!song || !song.sections) return progression;
  song.sections.forEach(sec => {
    (sec.lines || []).forEach(line => {
      (line.chords || []).sort((a, b) => a.x - b.x).forEach(c => {
        if (c.name && c.name.trim()) progression.push(c.name.trim());
      });
    });
  });
  return progression;
}

// Key detection using Krumhansl-Schmuckler key-finding algorithm (simplified)
const KEY_PROFILES = {
  // Major key profiles (C, C#, D, D#, E, F, F#, G, G#, A, A#, B)
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
};

const KEY_NAMES_MAJOR = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_NAMES_MINOR = ['Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bm'];

function detectKey(song) {
  const chords = extractAllChords(song);
  if (chords.length === 0) return null;

  // Build a pitch class distribution from chord roots
  const pitchClasses = new Array(12).fill(0);
  chords.forEach(chord => {
    const m = chord.match(/^([A-G][#b]?)/);
    if (m) {
      const idx = noteToSemitone(m[1]);
      if (idx !== -1) pitchClasses[idx]++;
    }
  });

  // Normalize
  const total = pitchClasses.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const normalized = pitchClasses.map(c => c / total);

  // Correlate with key profiles
  let bestKey = null;
  let bestScore = -Infinity;
  let bestMode = '';

  ['major', 'minor'].forEach(mode => {
    const profile = KEY_PROFILES[mode];
    for (let shift = 0; shift < 12; shift++) {
      // Rotate profile by shift
      let score = 0;
      for (let i = 0; i < 12; i++) {
        score += normalized[i] * profile[(i + shift) % 12];
      }
      if (score > bestScore) {
        bestScore = score;
        bestMode = mode;
        bestKey = shift;
      }
    }
  });

  const keyNames = bestMode === 'major' ? KEY_NAMES_MAJOR : KEY_NAMES_MINOR;
  const detectedKey = keyNames[bestKey];

  // Calculate confidence (0-100%)
  const confidence = Math.min(99, Math.round(bestScore * 100));

  // Also check if user-set key matches
  const userKey = song.key || null;

  return { detected: detectedKey, confidence, userKey, match: userKey && userKey.toLowerCase() === detectedKey.toLowerCase() };
}

function showSongStatsPanel() {
  const panel = $('song-stats-panel');
  if (!panel) return;

  const song = getSong(currentSongId);
  const body = $('stats-body');
  if (!body) return;

  if (!song) {
    body.innerHTML = `<div class="stats-empty"><div class="stats-empty-icon">▤</div><div>Select a song to view statistics</div></div>`;
  } else {
    body.innerHTML = computeStatsHTML(song);
  }

  panel.style.display = 'flex';

  // Close on backdrop tap
  panel.querySelector('.toolbar-sheet-backdrop').onclick = () => {
    panel.style.display = 'none';
  };
}

function computeStatsHTML(song) {
  const chordFreq = getChordFrequency(song);
  const wordCount = countWords(song);
  const sectionBreakdown = getSectionBreakdown(song);
  const progression = getChordProgression(song);
  const keyResult = detectKey(song);
  const totalChords = chordFreq.reduce((a, b) => a + b[1], 0);
  const uniqueChords = chordFreq.length;
  const totalSections = song.sections ? song.sections.length : 0;
  const totalLines = song.sections ? song.sections.reduce((a, s) => a + (s.lines || []).length, 0) : 0;

  let html = '';

  // Overview cards
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">Overview</div>';
  html += '<div class="stats-overview">';
  html += `<div class="stat-card"><div class="stat-card-value">${wordCount}</div><div class="stat-card-label">Words</div></div>`;
  html += `<div class="stat-card"><div class="stat-card-value chord">${totalChords}</div><div class="stat-card-label">Chords</div></div>`;
  html += `<div class="stat-card"><div class="stat-card-value section">${totalSections}</div><div class="stat-card-label">Sections</div></div>`;
  html += `<div class="stat-card"><div class="stat-card-value">${totalLines}</div><div class="stat-card-label">Lines</div></div>`;
  const audioSize = computeAudioSize(song);
  const audioCount = song.audio ? song.audio.length : 0;
  if (audioCount > 0) {
    html += `<div class="stat-card"><div class="stat-card-value recording">${formatBytes(audioSize)}</div><div class="stat-card-label">${audioCount} Recording${audioCount !== 1 ? 's' : ''}</div></div>`;
  }
  html += '</div></div>';

  // Key Detection
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">Key Detection</div>';
  if (keyResult) {
    html += '<div class="stats-key-result">';
    html += `<div class="stats-key-value">${esc(keyResult.detected)}</div>`;
    html += '<div class="stats-key-label">Detected Key</div>';
    html += `<div class="stats-key-confidence">Confidence: ${keyResult.confidence}%</div>`;
    if (keyResult.userKey) {
      html += `<div class="stats-key-alt">Song key: ${esc(keyResult.userKey)} ${keyResult.match ? '✓ matches' : '— different'}</div>`;
    }
    html += '</div>';
  } else {
    html += '<div class="stats-empty">No chords to analyze</div>';
  }
  html += '</div>';

  // Chord Frequency
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">Chord Frequency</div>';
  if (chordFreq.length > 0) {
    const maxCount = chordFreq[0][1];
    html += '<div class="stats-chord-list">';
    chordFreq.forEach(([chord, count]) => {
      const pct = Math.round((count / maxCount) * 100);
      html += `<div class="stats-chord-row">`;
      html += `<span class="stats-chord-name">${esc(chord)}</span>`;
      html += `<div class="stats-chord-bar-wrap"><div class="stats-chord-bar" style="width:${pct}%"></div></div>`;
      html += `<span class="stats-chord-count">${count}</span>`;
      html += '</div>';
    });
    html += '</div>';
    html += `<div style="font-size:11px;color:var(--fg-tertiary);margin-top:6px;">${uniqueChords} unique chord${uniqueChords !== 1 ? 's' : ''} from ${totalChords} total</div>`;
  } else {
    html += '<div class="stats-empty">No chords in this song</div>';
  }
  html += '</div>';

  // Chord Progression
  if (progression.length > 0) {
    html += '<div class="stats-section">';
    html += '<div class="stats-section-title">Chord Progression</div>';
    html += '<div class="stats-progression">';
    const rootChord = keyResult ? keyResult.detected.replace('m', '') : null;
    progression.forEach((chord, i) => {
      if (i > 0) html += '<span class="stats-prog-arrow">→</span>';
      const isRoot = rootChord && chord.startsWith(rootChord) && chord === rootChord;
      html += `<span class="stats-prog-chord${isRoot ? ' root' : ''}">${esc(chord)}</span>`;
    });
    html += '</div></div>';
  }

  // Section Breakdown
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">Section Breakdown</div>';
  if (sectionBreakdown.length > 0) {
    const maxLines = Math.max(...sectionBreakdown.map(s => s.lines), 1);
    html += '<div class="stats-section-list">';
    sectionBreakdown.forEach(sec => {
      const pct = Math.round((sec.lines / maxLines) * 100);
      html += '<div class="stats-section-row">';
      html += `<span class="stats-section-type">${esc(sec.type)}</span>`;
      html += `<span class="stats-section-detail">${sec.lines} line${sec.lines !== 1 ? 's' : ''} · ${sec.chords} chord${sec.chords !== 1 ? 's' : ''}</span>`;
      html += `<div class="stats-section-bar-wrap"><div class="stats-section-bar" style="width:${pct}%"></div></div>`;
      html += '</div>';
    });
    html += '</div>';
  }
  html += '</div>';

  // Song metadata
  html += '<div class="stats-section">';
  html += '<div class="stats-section-title">Details</div>';
  html += '<div class="stats-section-list">';
  html += `<div class="stats-section-row"><span class="stats-section-type">BPM</span><span class="stats-section-detail">${song.bpm || '—'}</span></div>`;
  html += `<div class="stats-section-row"><span class="stats-section-type">Time Sig</span><span class="stats-section-detail">${song.time_sig || '—'}</span></div>`;
  html += `<div class="stats-section-row"><span class="stats-section-type">Created</span><span class="stats-section-detail">${song.created_at ? new Date(song.created_at).toLocaleDateString() : '—'}</span></div>`;
  html += `<div class="stats-section-row"><span class="stats-section-type">Modified</span><span class="stats-section-detail">${song.updated_at ? new Date(song.updated_at).toLocaleDateString() : '—'}</span></div>`;
  html += '</div></div>';

  return html;
}

init();

// ===== Service Worker (PWA) =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}

// ===== Tag Management =====

// Collect all unique tags across all songs
function getAllTags() {
  const tagSet = new Set();
  songs.forEach(s => {
    (s.tags || []).forEach(t => tagSet.add(t));
  });
  return [...tagSet].sort((a, b) => a.localeCompare(b));
}

// Render tag filter bar below search
function renderTagFilterBar() {
  const bar = $('tag-filter-bar');
  if (!bar) return;
  const allTags = getAllTags();
  if (!allTags.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  let html = '<div class="tag-filter-list">';
  allTags.forEach(tag => {
    const active = activeTagFilter === tag ? ' active' : '';
    html += `<button class="tag-filter-chip${active}" data-tag="${esc(tag)}">${esc(tag)}</button>`;
  });
  html += '</div>';
  if (activeTagFilter) {
    html += '<button class="tag-filter-clear" data-tag="">✕ Clear</button>';
  }
  bar.innerHTML = html;
}

// Show tag editor panel for current song
function showTagEditorPanel() {
  hideToolbarSheet();
  const panel = $('tag-editor-panel');
  if (!panel) return;
  const song = getSong(currentSongId);
  if (!song) { toast('No song selected'); return; }

  renderTagEditorContent(song);
  panel.style.display = 'flex';

  // Close on backdrop tap
  panel.querySelector('.toolbar-sheet-backdrop').onclick = () => {
    panel.style.display = 'none';
  };
}

function renderTagEditorContent(song) {
  const currentChips = $('tag-editor-chips');
  const allChips = $('tag-editor-all-chips');
  const input = $('tag-editor-input');
  if (!currentChips || !allChips) return;

  const songTags = song.tags || [];
  const allTags = getAllTags();

  // Current song tags
  if (!songTags.length) {
    currentChips.innerHTML = '<span class="tag-editor-empty">No tags yet</span>';
  } else {
    currentChips.innerHTML = '';
    songTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip tag-chip-active';
      chip.innerHTML = `${esc(tag)}<button class="tag-chip-remove" data-tag="${esc(tag)}" title="Remove">✕</button>`;
      chip.querySelector('.tag-chip-remove').addEventListener('click', async () => {
        song.tags = (song.tags || []).filter(t => t !== tag);
        await saveSingleSong(song);
        renderTagEditorContent(song);
        renderTagFilterBar();
        renderSongList($('search-input')?.value || '');
        toast(`Removed "${tag}"`);
      });
      currentChips.appendChild(chip);
    });
  }

  // All tags (suggestions)
  allChips.innerHTML = '';
  allTags.forEach(tag => {
    const chip = document.createElement('span');
    const hasIt = songTags.includes(tag);
    chip.className = 'tag-chip' + (hasIt ? ' tag-chip-disabled' : '');
    chip.textContent = esc(tag);
    if (!hasIt) {
      chip.addEventListener('click', async () => {
        if (!song.tags) song.tags = [];
        song.tags.push(tag);
        song.tags.sort((a, b) => a.localeCompare(b));
        await saveSingleSong(song);
        renderTagEditorContent(song);
        renderTagFilterBar();
        renderSongList($('search-input')?.value || '');
      });
    }
    allChips.appendChild(chip);
  });

  // Clear input
  if (input) input.value = '';
}

// Setup tag editor events (called from setupEvents)
function setupTagEditorEvents() {
  const addBtn = $('tag-editor-add-btn');
  const input = $('tag-editor-input');

  if (addBtn && input) {
    addBtn.addEventListener('click', async () => {
      const val = input.value.trim();
      if (!val) return;
      const song = getSong(currentSongId);
      if (!song) return;
      if (!song.tags) song.tags = [];
      if (song.tags.includes(val)) { toast('Tag already exists'); return; }
      song.tags.push(val);
      song.tags.sort((a, b) => a.localeCompare(b));
      await saveSingleSong(song);
      renderTagEditorContent(song);
      renderTagFilterBar();
      renderSongList($('search-input')?.value || '');
      input.value = '';
      input.focus();
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });
  }

  // Tag filter bar events
  const filterBar = $('tag-filter-bar');
  if (filterBar) {
    filterBar.addEventListener('click', e => {
      const chip = e.target.closest('.tag-filter-chip');
      const clear = e.target.closest('.tag-filter-clear');
      if (chip) {
        const tag = chip.dataset.tag;
        if (activeTagFilter === tag) {
          activeTagFilter = null;
        } else {
          activeTagFilter = tag;
        }
        renderTagFilterBar();
        renderSongList($('search-input')?.value || '');
      } else if (clear) {
        activeTagFilter = null;
        renderTagFilterBar();
        renderSongList($('search-input')?.value || '');
      }
    });
  }
}


// ===== Drag-and-Drop File Import =====
function initDragDrop() {
  const overlay = $('drag-overlay');
  if (!overlay) return;
  let dragCounter = 0;

  document.addEventListener('dragenter', e => {
    e.preventDefault();
    // Only show overlay for file drags
    if (e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
      dragCounter++;
      overlay.classList.add('active');
    }
  });

  document.addEventListener('dragleave', e => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.remove('active');
    }
  });

  document.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      // Filter to supported file types (matches file input accept list)
      const valid = Array.from(files).filter(f => /\.(txt|md|text|cho|crd|chopro)$/i.test(f.name));
      if (valid.length > 0) {
        importFiles(valid);
      } else {
        toast('Drop .txt, .md, or ChordPro (.cho/.crd/.chopro) files to import', 'error');
      }
    }
  });
}

// ===== Keyboard Shortcuts Overlay =====
function showShortcuts() {
  const overlay = $('shortcuts-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  // Focus the close button for accessibility
  const closeBtn = overlay.querySelector('.shortcuts-close');
  if (closeBtn) closeBtn.focus();
}

function hideShortcuts() {
  const overlay = $('shortcuts-overlay');
  if (!overlay) return;
  overlay.style.display = 'none';
}

// Wire up shortcuts overlay close
document.addEventListener('DOMContentLoaded', () => {
  const overlay = $('shortcuts-overlay');
  if (!overlay) return;
  const closeBtn = overlay.querySelector('.shortcuts-close');
  const backdrop = overlay.querySelector('.shortcuts-backdrop');
  if (closeBtn) closeBtn.addEventListener('click', hideShortcuts);
  if (backdrop) backdrop.addEventListener('click', hideShortcuts);
});

// ===== Find in Song =====
let findMatches = [];
let findCurrentIdx = -1;
let findQuery = '';

function toggleFindBar() {
  const bar = $('find-bar');
  if (bar.style.display !== 'none') {
    hideFindBar();
  } else {
    showFindBar();
  }
}

function showFindBar() {
  const bar = $('find-bar');
  bar.style.display = 'block';
  const input = $('find-input');
  input.value = '';
  input.focus();
  findMatches = [];
  findCurrentIdx = -1;
  findQuery = '';
  updateFindCount();
}

function hideFindBar() {
  const bar = $('find-bar');
  bar.style.display = 'none';
  clearFindHighlights();
  findMatches = [];
  findCurrentIdx = -1;
  findQuery = '';
}

function clearFindHighlights() {
  const body = $('song-body');
  if (!body) return;
  body.querySelectorAll('.find-highlight, .find-highlight-active').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

function highlightAllMatches() {
  clearFindHighlights();
  if (!findQuery) return;
  const body = $('song-body');
  if (!body) return;

  const song = getSong(currentSongId);
  if (!song) return;

  // Collect all text nodes in the editor body
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const query = findQuery.toLowerCase();
  findMatches = [];

  textNodes.forEach(node => {
    const text = node.textContent;
    const lower = text.toLowerCase();
    let start = 0;
    while (true) {
      const idx = lower.indexOf(query, start);
      if (idx === -1) break;
      findMatches.push({ node, start: idx, end: idx + query.length });
      start = idx + query.length;
    }
  });

  // Highlight matches (process in reverse to preserve offsets)
  findMatches.reverse().forEach(match => {
    const { node, start, end } = match;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const span = document.createElement('span');
    span.className = 'find-highlight';
    try { range.surroundContents(span); } catch(e) { /* skip if split across elements */ }
  });

  if (findMatches.length > 0) {
    findCurrentIdx = findMatches.length - 1; // last because we reversed
    updateActiveHighlight();
    scrollToMatch(findCurrentIdx);
  }
  updateFindCount();
}

function updateActiveHighlight() {
  const body = $('song-body');
  if (!body) return;
  body.querySelectorAll('.find-highlight-active').forEach(el => el.className = 'find-highlight');
  if (findCurrentIdx >= 0 && findCurrentIdx < findMatches.length) {
    const highlights = body.querySelectorAll('.find-highlight');
    const hl = highlights[findMatches.length - 1 - findCurrentIdx];
    if (hl) hl.className = 'find-highlight-active';
  }
}

function scrollToMatch(idx) {
  const body = $('song-body');
  if (!body || idx < 0 || idx >= findMatches.length) return;
  const highlights = body.querySelectorAll('.find-highlight');
  const hl = highlights[findMatches.length - 1 - idx];
  if (hl) {
    hl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updateFindCount() {
  const el = $('find-count');
  if (!el) return;
  if (!findQuery) { el.textContent = ''; return; }
  if (findMatches.length === 0) { el.textContent = '0/0'; return; }
  el.textContent = `${findCurrentIdx + 1}/${findMatches.length}`;
}

function findNext() {
  if (!findQuery) return;
  if (findMatches.length === 0) { highlightAllMatches(); return; }
  findCurrentIdx = (findCurrentIdx + 1) % findMatches.length;
  updateActiveHighlight();
  scrollToMatch(findCurrentIdx);
  updateFindCount();
}

function findPrev() {
  if (!findQuery) return;
  if (findMatches.length === 0) { highlightAllMatches(); return; }
  findCurrentIdx = (findCurrentIdx - 1 + findMatches.length) % findMatches.length;
  updateActiveHighlight();
  scrollToMatch(findCurrentIdx);
  updateFindCount();
}

// ===== Tuner / Pitch Detection =====
let tunerStream = null;
let tunerAudioCtx = null;
let tunerAnalyser = null;
let tunerAnimFrame = null;
let tunerActive = false;
let tunerTargetNote = 'E2';

// Standard guitar string frequencies
const STRING_FREQS = {
  'E2': 82.41, 'A2': 110.00, 'D3': 146.83,
  'G3': 196.00, 'B3': 246.94, 'E4': 329.63,
  'D2': 73.42, 'G2': 98.00, 'C3': 130.81, 'F3': 174.61,
  'A4': 440.00, 'C4': 261.63, 'E3': 164.81, 'G4': 392.00,
  'D4': 293.66, 'F4': 349.23, 'B1': 61.74
};

// Tuning presets — each defines the string notes (low to high) and display labels
const TUNING_PRESETS = {
  'guitar-standard': {
    label: 'Guitar',
    strings: [
      { note: 'E2', label: 'E₂' },
      { note: 'A2', label: 'A₂' },
      { note: 'D3', label: 'D₃' },
      { note: 'G3', label: 'G₃' },
      { note: 'B3', label: 'B₃' },
      { note: 'E4', label: 'E₄' }
    ]
  },
  'drop-d': {
    label: 'Drop D',
    strings: [
      { note: 'D2', label: 'D₂' },
      { note: 'A2', label: 'A₂' },
      { note: 'D3', label: 'D₃' },
      { note: 'G3', label: 'G₃' },
      { note: 'B3', label: 'B₃' },
      { note: 'E4', label: 'E₄' }
    ]
  },
  'open-g': {
    label: 'Open G',
    strings: [
      { note: 'D2', label: 'D₂' },
      { note: 'G2', label: 'G₂' },
      { note: 'D3', label: 'D₃' },
      { note: 'G3', label: 'G₃' },
      { note: 'B3', label: 'B₃' },
      { note: 'D4', label: 'D₄' }
    ]
  },
  'dadgad': {
    label: 'DADGAD',
    strings: [
      { note: 'D2', label: 'D₂' },
      { note: 'A2', label: 'A₂' },
      { note: 'D3', label: 'D₃' },
      { note: 'G3', label: 'G₃' },
      { note: 'A4', label: 'A₄' },
      { note: 'D4', label: 'D₄' }
    ]
  },
  'ukulele': {
    label: 'Ukulele',
    strings: [
      { note: 'G4', label: 'G₄' },
      { note: 'C4', label: 'C₄' },
      { note: 'E3', label: 'E₃' },
      { note: 'A4', label: 'A₄' }
    ]
  },
  'bass': {
    label: 'Bass',
    strings: [
      { note: 'B1', label: 'B₁' },
      { note: 'E2', label: 'E₂' },
      { note: 'A2', label: 'A₂' },
      { note: 'D3', label: 'D₃' }
    ]
  }
};

let activeTuningPreset = 'guitar-standard';

function applyTuningPreset(presetKey) {
  const preset = TUNING_PRESETS[presetKey];
  if (!preset) return;
  activeTuningPreset = presetKey;

  // Update preset button active state
  document.querySelectorAll('.tuner-preset-btn').forEach(btn => {
    const isMatch = btn.dataset.preset === presetKey;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-checked', isMatch ? 'true' : 'false');
  });

  // Rebuild string buttons
  const container = document.querySelector('.tuner-string-buttons');
  if (!container) return;
  container.innerHTML = '';
  preset.strings.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'tuner-string-btn' + (i === 0 ? ' active' : '');
    btn.dataset.note = s.note;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
    btn.textContent = s.label;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tuner-string-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-checked', 'true');
      tunerTargetNote = btn.dataset.note;
      updateTunerTargetDisplay();
      haptic(10);
    });
    container.appendChild(btn);
  });

  // Set first string as target
  tunerTargetNote = preset.strings[0].note;
  updateTunerTargetDisplay();
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function freqToNote(freq) {
  if (freq <= 0) return null;
  // A4 = 440Hz = MIDI 69
  const midi = 12 * Math.log2(freq / 440) + 69;
  const midiRound = Math.round(midi);
  const cents = Math.round((midi - midiRound) * 100);
  const noteIdx = ((midiRound % 12) + 12) % 12;
  const octave = Math.floor(midiRound / 12) - 1;
  return {
    name: NOTE_NAMES[noteIdx],
    octave: octave,
    cents: cents,
    freq: freq,
    midi: midiRound
  };
}

// Autocorrelation pitch detection
function autoCorrelate(buf, sampleRate) {
  const bufLen = buf.length;
  // Downsample to reduce computation
  const downsampleFactor = 4;
  const downsampledLen = Math.floor(bufLen / downsampleFactor);
  const downsampled = new Float32Array(downsampledLen);
  for (let i = 0; i < downsampledLen; i++) {
    downsampled[i] = buf[i * downsampleFactor];
  }
  const effectiveSR = sampleRate / downsampleFactor;

  // RMS check — skip if too quiet
  let rms = 0;
  for (let i = 0; i < downsampledLen; i++) rms += downsampled[i] * downsampled[i];
  rms = Math.sqrt(rms / downsampledLen);
  if (rms < 0.01) return -1; // too quiet

  // Autocorrelation
  const minPeriod = Math.floor(effectiveSR / 500); // max freq 500Hz (covers guitar low E + harmonics)
  const maxPeriod = Math.floor(effectiveSR / 50);  // min freq 50Hz

  let bestCorr = -1;
  let bestPeriod = -1;

  for (let period = minPeriod; period <= maxPeriod && period < downsampledLen; period++) {
    let corr = 0;
    const compareLen = Math.min(downsampledLen - period, 512);
    for (let i = 0; i < compareLen; i++) {
      corr += Math.abs(downsampled[i] * downsampled[i + period]);
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestPeriod = period;
    }
  }

  if (bestPeriod === -1) return -1;

  // Parabolic interpolation for better accuracy
  const y1 = bestCorr;
  let y0 = 0, y2 = 0;
  if (bestPeriod > minPeriod) {
    for (let i = 0; i < Math.min(downsampledLen - (bestPeriod - 1), 512); i++) {
      y0 += Math.abs(downsampled[i] * downsampled[i + bestPeriod - 1]);
    }
  }
  if (bestPeriod < maxPeriod && (bestPeriod + 1) < downsampledLen) {
    for (let i = 0; i < Math.min(downsampledLen - (bestPeriod + 1), 512); i++) {
      y2 += Math.abs(downsampled[i] * downsampled[i + bestPeriod + 1]);
    }
  }

  const shift = (y2 - y0) / (2 * (2 * y1 - y0 - y2 + 1e-10));
  const refinedPeriod = bestPeriod + shift;

  return effectiveSR / refinedPeriod;
}

function tunerTick() {
  if (!tunerActive) return;

  const bufferLength = tunerAnalyser.fftSize;
  const dataArray = new Float32Array(bufferLength);
  tunerAnalyser.getFloatTimeDomainData(dataArray);

  const freq = autoCorrelate(dataArray, tunerAudioCtx.sampleRate);

  if (freq > 0) {
    const note = freqToNote(freq);
    if (note) {
      updateTunerDisplay(note);
    }
  }

  tunerAnimFrame = requestAnimationFrame(tunerTick);
}

function updateTunerDisplay(note) {
  const noteEl = $('tuner-note');
  const freqEl = $('tuner-frequency');
  const centsEl = $('tuner-cents');
  const needle = $('tuner-needle');
  const status = $('tuner-status');

  if (noteEl) {
    noteEl.textContent = note.name;
    noteEl.classList.toggle('in-tune', Math.abs(note.cents) < 5);
  }
  if (freqEl) freqEl.textContent = `${note.freq.toFixed(1)} Hz`;

  if (centsEl) {
    if (Math.abs(note.cents) < 5) {
      centsEl.textContent = '✓ In tune';
      centsEl.className = 'tuner-cents in-tune';
    } else if (note.cents > 0) {
      centsEl.textContent = `+${note.cents}¢ sharp`;
      centsEl.className = 'tuner-cents sharp';
    } else {
      centsEl.textContent = `${note.cents}¢ flat`;
      centsEl.className = 'tuner-cents flat';
    }
  }

  // Needle: map -50..+50 cents to -130..+130px (half of 280px meter minus margin)
  if (needle) {
    const clamped = Math.max(-50, Math.min(50, note.cents));
    const px = (clamped / 50) * 130;
    needle.style.transform = `translateX(-50%) translateX(${px}px)`;
  }

  // Check if near target string
  const targetFreq = STRING_FREQS[tunerTargetNote];
  if (targetFreq) {
    const centsFromTarget = 1200 * Math.log2(note.freq / targetFreq);
    if (Math.abs(centsFromTarget) < 15) {
      if (status) {
        status.textContent = `🎯 Near ${tunerTargetNote}!`;
        status.className = 'tuner-status active';
      }
      // Highlight matching string button
      document.querySelectorAll('.tuner-string-btn').forEach(btn => {
        btn.classList.toggle('near-match', btn.dataset.note === tunerTargetNote);
      });
    } else {
      if (status) {
        status.textContent = `Detected: ${note.name}${note.octave}`;
        status.className = 'tuner-status';
      }
      document.querySelectorAll('.tuner-string-btn').forEach(btn => {
        btn.classList.remove('near-match');
      });
    }
  }
}

async function startTuner() {
  try {
    tunerStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 1
      }
    });

    tunerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    tunerAnalyser = tunerAudioCtx.createAnalyser();
    tunerAnalyser.fftSize = 4096;
    tunerAnalyser.smoothingTimeConstant = 0;

    const source = tunerAudioCtx.createMediaStreamSource(tunerStream);
    source.connect(tunerAnalyser);

    tunerActive = true;
    tunerTick();

    const btn = $('tuner-start-btn');
    if (btn) {
      btn.textContent = 'Stop';
      btn.classList.add('stopping');
    }
    const status = $('tuner-status');
    if (status) {
      status.textContent = 'Listening… Play a string';
      status.className = 'tuner-status active';
    }
  } catch (e) {
    console.error('Tuner start failed:', e);
    toast('Microphone access denied', 'error');
  }
}

function stopTuner() {
  tunerActive = false;
  if (tunerAnimFrame) { cancelAnimationFrame(tunerAnimFrame); tunerAnimFrame = null; }
  if (tunerStream) { tunerStream.getTracks().forEach(t => t.stop()); tunerStream = null; }
  if (tunerAudioCtx) { tunerAudioCtx.close(); tunerAudioCtx = null; }
  tunerAnalyser = null;

  const btn = $('tuner-start-btn');
  if (btn) {
    btn.textContent = 'Start';
    btn.classList.remove('stopping');
  }
  const status = $('tuner-status');
  if (status) {
    status.textContent = 'Tap start to begin tuning';
    status.className = 'tuner-status';
  }
  const noteEl = $('tuner-note');
  if (noteEl) { noteEl.textContent = '—'; noteEl.classList.remove('in-tune'); }
  const freqEl = $('tuner-frequency');
  if (freqEl) freqEl.textContent = 'Hz';
  const centsEl = $('tuner-cents');
  if (centsEl) { centsEl.textContent = ''; centsEl.className = 'tuner-cents'; }
  const needle = $('tuner-needle');
  if (needle) needle.style.transform = 'translateX(-50%) translateX(0px)';
  document.querySelectorAll('.tuner-string-btn').forEach(btn => btn.classList.remove('near-match'));
}

function showTunerPanel() {
  const panel = $('tuner-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  updateTunerTargetDisplay();

  panel.querySelector('.toolbar-sheet-backdrop').onclick = () => {
    stopTuner();
    panel.style.display = 'none';
  };
}

function updateTunerTargetDisplay() {
  const freq = STRING_FREQS[tunerTargetNote];
  const el = $('tuner-target');
  if (el) el.textContent = `Target: ${tunerTargetNote} (${freq.toFixed(1)} Hz)`;
}

// Find bar event wiring
document.addEventListener('DOMContentLoaded', () => {
  const input = $('find-input');
  if (!input) return;
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      findQuery = input.value.trim();
      if (findQuery) {
        highlightAllMatches();
      } else {
        clearFindHighlights();
        findMatches = [];
        findCurrentIdx = -1;
        updateFindCount();
      }
    }, 150);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrev(); else findNext();
    }
    if (e.key === 'Escape') hideFindBar();
  });
  const prevBtn = $('find-prev');
  const nextBtn = $('find-next');
  const closeBtn = $('find-close');
  if (prevBtn) prevBtn.addEventListener('click', findPrev);
  if (nextBtn) nextBtn.addEventListener('click', findNext);
  if (closeBtn) closeBtn.addEventListener('click', hideFindBar);
});

// ===== Feature Discovery Hint System =====
// Shows a subtle, dismissible tooltip the first time a user encounters a power feature.
// Hints auto-dismiss on tap-outside or after 4s. Each hint is shown at most once.
function showFeatureHint(targetEl, text, side = 'bottom') {
  if (!targetEl) return;
  // Remove any existing hint
  const existing = document.querySelector('.feature-hint');
  if (existing) existing.remove();

  const hint = document.createElement('div');
  hint.className = `feature-hint feature-hint-${side}`;
  hint.setAttribute('role', 'tooltip');
  hint.innerHTML = `<span class="feature-hint-text">${esc(text)}</span><button class="feature-hint-dismiss" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(hint);

  // Position relative to target
  const rect = targetEl.getBoundingClientRect();
  const hintRect = hint.getBoundingClientRect();
  let top, left;
  if (side === 'bottom') {
    top = rect.bottom + 8;
    left = rect.left + rect.width / 2 - hintRect.width / 2;
  } else if (side === 'top') {
    top = rect.top - hintRect.height - 8;
    left = rect.left + rect.width / 2 - hintRect.width / 2;
  } else if (side === 'left') {
    top = rect.top + rect.height / 2 - hintRect.height / 2;
    left = rect.left - hintRect.width - 8;
  } else {
    top = rect.top + rect.height / 2 - hintRect.height / 2;
    left = rect.right + 8;
  }
  // Clamp to viewport
  left = Math.max(8, Math.min(left, window.innerWidth - hintRect.width - 8));
  top = Math.max(8, top);
  hint.style.top = `${top}px`;
  hint.style.left = `${left}px`;

  // Animate in
  requestAnimationFrame(() => hint.classList.add('feature-hint-visible'));

  // Dismiss handlers
  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    hint.classList.remove('feature-hint-visible');
    setTimeout(() => hint.remove(), 250);
  }
  hint.querySelector('.feature-hint-dismiss').addEventListener('click', dismiss);
  // Tap outside to dismiss
  const outsideHandler = (e) => {
    if (!hint.contains(e.target) && !targetEl.contains(e.target)) {
      dismiss();
      document.removeEventListener('touchstart', outsideHandler);
      document.removeEventListener('click', outsideHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener('touchstart', outsideHandler, { passive: true });
    document.addEventListener('click', outsideHandler);
  }, 100);
  // Auto-dismiss after 4s
  setTimeout(dismiss, 4000);
}
