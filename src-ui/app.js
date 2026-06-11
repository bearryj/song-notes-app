// ===== Song Notes Mobile — Apple Notes Style =====

import { invoke } from '@tauri-apps/api/core';

let isTauri = false;
let songs = [];
let folders = ['All Songs'];
let currentFolder = 'All Songs';
let currentSongId = null;
let viewStack = ['folder-view'];
let autoSaveTimer = null;
let versionHistory = [];
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioPlayer = new Audio();
let hasChanges = false;

// ===== Setlist State =====
let setlists = [];
let activeSetlistId = null;

// ===== Metronome State =====
let metroBpm = 120;
let metroTimeSig = 4;
let metroPlaying = false;
let metroInterval = null;
let metroBeatIndex = 0;
let metroAudioCtx = null;
let metroNextNoteTime = 0;
let metroTimerID = null;
let metroSchedulerInterval = 25; // ms
let metroLookahead = 100; // ms

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
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id)?.classList.add('active');
}
function pushView(id) { viewStack.push(id); showView(id); }
function popView() { if (viewStack.length > 1) { viewStack.pop(); showView(viewStack[viewStack.length - 1]); } }

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
}
async function saveSongs() {
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) for (const s of songs) await tauriSaveSong(s);
}
async function saveSingleSong(song) {
  if (!song) return;
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song; else songs.unshift(song);
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) await tauriSaveSong(song);
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function createSong(title) {
  return {
    id: generateId(), title: title || 'Untitled', key: '', bpm: null, time_sig: null,
    tags: [], folder: currentFolder === 'All Songs' ? null : currentFolder,
    sections: [{ type: 'Verse', lines: [{ text: '', chords: [] }] }],
    audio: [], pinned: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

function getSong(id) { return songs.find(s => s.id === id); }

async function deleteSong(id) {
  songs = songs.filter(s => s.id !== id);
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) await tauriDeleteSong(id);
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
  if (!versionHistory.length) { list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg-tertiary);font-size:13px;">No versions yet</div>'; return; }
  list.innerHTML = [...versionHistory].reverse().map(v => `<div class="hist-item" data-ts="${v.ts}"><div class="hist-time">${new Date(v.ts).toLocaleTimeString()}</div><div class="hist-meta">${v.key || '—'} · ${v.sections.reduce((a,s) => a + s.lines.length, 0)} lines</div></div>`).join('');
  list.querySelectorAll('.hist-item').forEach(el => {
    el.addEventListener('click', () => {
      const v = versionHistory.find(x => x.ts === parseInt(el.dataset.ts));
      if (!v) return;
      showVersionDiff(v);
    });
  });
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
        <div class="diff-key-changes">${version.key || '—'} → ${song.key || '—'}</div>
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
    if (!confirm('Restore this version? Current version will be lost.')) return;
    const song2 = getSong(currentSongId);
    if (!song2) return;
    song2.key = version.key;
    song2.sections = JSON.parse(JSON.stringify(version.sections));
    saveSingleSong(song2);
    openEditor(currentSongId);
    modal.remove();
    $('history-panel').style.display = 'none';
    toast('Version restored');
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    audioChunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const song = getSong(currentSongId);
        if (!song) return;
        if (!song.audio) song.audio = [];
        song.audio.push({ data: reader.result, ts: Date.now() });
        await saveSingleSong(song); updateRecordUI();
        toast(`Recording saved (${song.audio.length})`);
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start();
    isRecording = true;
    updateRecordUI();
  } catch (e) {
    toast('Microphone access denied', 'error');
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) { mediaRecorder.stop(); isRecording = false; updateRecordUI(); }
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
  if (!audioPlayer.paused) { audioPlayer.pause(); audioPlayer.currentTime = 0; }
  audioPlayer.src = dataUrl; audioPlayer.play();
  document.querySelectorAll('.rec-item.recording-playing').forEach(i => i.classList.remove('recording-playing'));
  const item = document.querySelector(`.rec-item[data-url="${dataUrl}"]`);
  if (item) item.classList.add('recording-playing');
  audioPlayer.onended = () => document.querySelectorAll('.rec-item.recording-playing').forEach(i => i.classList.remove('recording-playing'));
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
    return `<div class="rec-item" data-url="${rec.data}"><span>Recording ${idx + 1} · ${new Date(rec.ts).toLocaleTimeString()}</span><button class="rec-play-btn">▶</button></div>`;
  }).join('');
  recList.querySelectorAll('.rec-play-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); playRecording(b.closest('.rec-item')?.dataset?.url); }));
  recList.querySelectorAll('.rec-item').forEach(item => item.addEventListener('click', () => playRecording(item.dataset.url)));
  $('delete-all-recordings').onclick = () => {
    if (!confirm('Delete all recordings?')) return;
    const s = getSong(currentSongId); if (s) { s.audio = []; saveSingleSong(s); }
    dd.style.display = 'none'; updateRecordUI();
  };
  dd.style.display = 'block';
}

// Render helpers
function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
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
    song.updated_at = new Date().toISOString();
    await saveSingleSong(song);
    hasChanges = false;
    $('save-btn').disabled = true;
    updateSaveDot('saved');
  }, 1200);
}

function updateSaveDot(state) {
  const dot = $('auto-save-dot');
  if (!dot) return;
  dot.className = 'save-dot ' + state;
}

// Folders
function renderFolders() {
  const el = $('folder-list');
  // Smart folders always at top
  const smartFolders = ['All Songs', 'Recently Edited'];
  const customFolders = folders.filter(f => !smartFolders.includes(f));
  
  el.innerHTML = [...smartFolders, ...customFolders].map(f => {
    const count = f === 'All Songs' ? songs.length : 
                  f === 'Recently Edited' ? songs.filter(s => {
                    const d = new Date(s.updated_at || s.created_at || 0);
                    return Date.now() - d.getTime() < 7 * 86400000;
                  }).length :
                  songs.filter(s => s.folder === f).length;
    const cls = f === currentFolder ? 'list-item active' : 'list-item';
    const icon = f === 'All Songs' ? '♫' : f === 'Recently Edited' ? '⏱' : '♪';
    return `<div class="${cls}" data-folder="${esc(f)}"><span class="item-icon">${icon}</span><span class="item-title">${esc(f === 'Recently Edited' ? 'Recently Edited' : f)}</span><span class="item-meta">${count}</span>${!smartFolders.includes(f) ? '<span class="folder-dots">⋯</span>' : ''}</div>`;
  }).join('');
  el.querySelectorAll('.list-item[data-folder]').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.folder-dots')) return;
      currentFolder = item.dataset.folder;
      $('folder-title').textContent = currentFolder;
      renderSongList(); pushView('song-list-view');
    });
    const dots = item.querySelector('.folder-dots');
    if (dots) dots.addEventListener('click', e => { e.stopPropagation(); showFolderActions(item.dataset.folder, dots); });
  });
}

let activeFolderName = '';
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
        const name = prompt('Folder name:', activeFolderName);
        if (name && name.trim() && name !== activeFolderName) {
          const idx = folders.indexOf(activeFolderName);
          if (idx >= 0) { folders[idx] = name.trim(); songs.forEach(s => { if (s.folder === activeFolderName) s.folder = name.trim(); }); }
          saveSongs(); persistFolders(); renderFolders();
        }
      } else if (btn.dataset.action === 'delete-folder') {
        if (confirm(`Delete "${activeFolderName}"? Songs move to All Songs.`)) {
          songs.forEach(s => { if (s.folder === activeFolderName) s.folder = null; });
          folders = folders.filter(f => f !== activeFolderName);
          saveSongs(); persistFolders(); renderFolders();
        }
      }
    });
  });
}

async function persistFolders() {
  localStorage.setItem('folders_app', JSON.stringify(folders));
  if (isTauri) await tauriSaveFolders(folders);
}

// Song context menu (long press)
let contextSongId = null;
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
        } else if (btn.dataset.action === 'export-txt') {
          downloadFile(buildExportText(s), `${s.title}.txt`, 'text/plain');
        } else if (btn.dataset.action === 'export-md') {
          downloadFile(buildExportMarkdown(s), `${s.title}.md`, 'text/markdown');
        } else if (btn.dataset.action === 'delete') {
          if (confirm(`Delete "${s.title}"?`)) {
            await deleteSong(contextSongId);
            if (currentSongId === contextSongId) { currentSongId = null; }
            renderSongList($('search-input').value);
            toast('Deleted');
          }
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

// Song list
function renderSongList(filter = '') {
  const el = $('song-list');
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
      return false;
    });
  }

  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">♪</div><h2>' + (filter ? 'No Results' : 'No Songs') + '</h2><p>' + (filter ? 'Try a different search' : 'Tap + to create one') + '</p></div>';
    return;
  }

  // Sort: pinned first (by updated_at), then unpinned (by updated_at)
  const sorted = [...list].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });

  // Build date-based sections
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const thisWeek = new Date(today.getTime() - 6 * 86400000);

  let html = '';
  let lastSection = '';

  sorted.forEach((s, i) => {
    const d = new Date(s.updated_at || s.created_at || 0);
    let section = '';
    const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (dd.getTime() === today.getTime()) section = 'Today';
    else if (dd.getTime() === yesterday.getTime()) section = 'Yesterday';
    else if (dd >= thisWeek) section = 'This Week';
    else if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) section = 'This Month';
    else section = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    if (section !== lastSection) {
      if (html) html += '</div>';
      html += `<div class="list-section-header">${esc(section)}</div><div class="list-section">`;
      lastSection = section;
    }

    const pinned = s.pinned ? '<span class="item-pin">★</span>' : '';
    html += `<div class="list-item" data-id="${s.id}">
      ${pinned}
      <span class="item-title">${esc(s.title || 'Untitled')}${s.key ? `<span class="item-key">${esc(s.key)}</span>` : ''}</span>
      <span class="item-meta">${fmtDate(s.updated_at)}</span>
    </div>`;
  });
  if (html) html += '</div>';

  el.innerHTML = html;

  // Attach events: click to open
  el.querySelectorAll('.list-item').forEach(item => {
    // Long press / hover context menu
    let longPressTimer = null;
    item.addEventListener('touchstart', e => {
      longPressTimer = setTimeout(() => { longPressTimer = null; showSongContext(item.dataset.id, item); }, 500);
    }, { passive: true });
    item.addEventListener('touchend', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } }, { passive: true });
    item.addEventListener('touchmove', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } }, { passive: true });

    item.addEventListener('click', () => {
      currentSongId = item.dataset.id;
      localStorage.setItem('songs_app_last', currentSongId);
      openEditor(currentSongId);
      pushView('editor-view');
    });

    // Swipe to delete
    let startX = 0, currentX = 0, isDragging = false;
    item.addEventListener('touchstart', e => {
      startX = e.changedTouches[0].clientX;
      isDragging = false;
    }, { passive: true });
    item.addEventListener('touchmove', e => {
      currentX = e.changedTouches[0].clientX;
      const diff = startX - currentX;
      if (diff > 20) { isDragging = true; item.style.transform = `translateX(${-Math.min(diff, 80)}px)`; item.style.transition = 'none'; }
      else if (diff < -20 && isDragging) { item.style.transform = ''; isDragging = false; }
    }, { passive: true });
    item.addEventListener('touchend', e => {
      if (isDragging && (startX - currentX) > 60) {
        // Swipe left = show delete
        const id = item.dataset.id;
        if (confirm(`Delete "${getSong(id)?.title || 'this song'}"?`)) {
          deleteSong(id);
          if (currentSongId === id) { currentSongId = null; }
          renderSongList($('search-input').value);
          toast('Deleted');
        }
      }
      item.style.transform = ''; item.style.transition = 'transform 0.2s ease';
      isDragging = false;
    }, { passive: true });
  });
}

// Editor
function openEditor(id) {
  const song = getSong(id);
  if (!song) return;
  $('song-title').value = song.title;
  versionHistory = [];
  hasChanges = false;
  $('save-btn').disabled = true;
  updateUndoBtn();
  renderEditorBody(song);
  updateRecordUI();
  updateSaveDot('saved');
  // Update info bar if visible
  const infoBar = $('info-bar');
  if (infoBar && infoBar.style.display === 'flex') updateInfoBar();
  // Update set-key button text in more menu
  const keyBtn = $('more-menu')?.querySelector('[data-action="set-key"]');
  if (keyBtn) keyBtn.textContent = song.key ? `Set Key: ${song.key}` : 'Set Key: —';
}

function renderEditorBody(song) {
  const el = $('song-body');
  el.innerHTML = '';
  song.sections.forEach((section, si) => {
    const tmpl = $('section-template').content.cloneNode(true);
    const sectionEl = tmpl.querySelector('.song-section');
    const typeSelect = tmpl.querySelector('.section-type');
    const opt = typeSelect.querySelector(`option[value="${esc(section.type)}"]`);
    if (opt) opt.selected = true;

    tmpl.querySelector('.delete-section').addEventListener('click', () => {
      if (song.sections.length <= 1) { toast('Need at least one section'); return; }
      song.sections.splice(si, 1); saveSingleSong(song); renderEditorBody(song);
    });
    typeSelect.addEventListener('change', () => { song.sections[si].type = typeSelect.value; triggerAutoSave(song); });
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

    // Drag to reorder
    sectionEl.draggable = true;
    sectionEl.addEventListener('dragstart', e => { sectionEl.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; });
    sectionEl.addEventListener('dragover', e => { e.preventDefault(); sectionEl.classList.add('drag-over'); });
    sectionEl.addEventListener('dragleave', () => sectionEl.classList.remove('drag-over'));
    sectionEl.addEventListener('drop', e => {
      e.preventDefault(); sectionEl.classList.remove('drag-over');
      const children = [...el.children];
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
    el.appendChild(sectionEl);
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

  lyricInput.addEventListener('input', () => {
    line.text = lyricInput.textContent;
    triggerAutoSave(song);
  });

  // Enter = split line, preserving chords
  lyricInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection();
      const textBefore = lyricInput.textContent.substring(0, sel?.focusOffset || 0);
      const textAfter = lyricInput.textContent.substring(sel?.focusOffset || 0);
      lyricInput.textContent = textBefore;
      const cursorX = (sel?.focusOffset || 0) * 8;
      // Chords before cursor stay, chords after move to new line
      const chordsBefore = line.chords.filter(c => c.x < cursorX);
      const chordsAfter = line.chords.filter(c => c.x >= cursorX).map(c => ({ ...c, x: c.x - cursorX }));
      line.chords = chordsBefore;
      song.sections[si].lines.splice(li + 1, 0, { text: textAfter, chords: chordsAfter });
      saveSingleSong(song);
      renderEditorBody(song);
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

      // Tap to edit
      marker.addEventListener('click', e => {
        e.stopPropagation();
        showChordEdit(song, line, ch);
      });

      // Long press to delete
      let longPressTimer = null;
      marker.addEventListener('touchstart', e => {
        longPressTimer = setTimeout(() => {
          marker.classList.add('chord-marker-deleting');
          navigator.vibrate?.(50);
          // Show delete confirmation
          const confirmDel = confirm(`Delete chord "${ch.name}"?`);
          marker.classList.remove('chord-marker-deleting');
          if (confirmDel) {
            line.chords = line.chords.filter(c => c !== chord);
            saveSingleSong(song);
            renderChordMarkers();
          }
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
    // Line delete button (always at end of chord row)
    const delBtn = document.createElement('button');
    delBtn.className = 'line-delete-btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      song.sections[si].lines.splice(li, 1);
      saveSingleSong(song);
      renderEditorBody(song);
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
  });
  sheet.appendChild(quickRow);

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'chord-popup-actions';

  const doneBtn = document.createElement('button');
  doneBtn.className = 'done-btn'; doneBtn.textContent = '✓ Done';
  doneBtn.addEventListener('click', () => {
    chord.name = input.value.trim();
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

function renderFretboard(container, chordName) {
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
      const y = padY - 14;
      svg += `<text x="${x}" y="${y}" fill="var(--fg-secondary)" font-size="14" font-family="var(--font)" text-anchor="middle" font-weight="bold">&#9675;</text>`;
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

function showChordDiagramPanel(initialChord) {
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
      </div>
      <div class="cd-fretboard-wrap" id="cd-fretboard-wrap"></div>
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

    $('cd-prev').addEventListener('click', () => {
      const name = $('cd-chord-name').textContent;
      const idx = ALL_CHORD_NAMES.indexOf(name);
      const prev = idx > 0 ? ALL_CHORD_NAMES[idx - 1] : ALL_CHORD_NAMES[ALL_CHORD_NAMES.length - 1];
      setDiagramChord(prev);
    });
    $('cd-next').addEventListener('click', () => {
      const name = $('cd-chord-name').textContent;
      const idx = ALL_CHORD_NAMES.indexOf(name);
      const next = idx < ALL_CHORD_NAMES.length - 1 ? ALL_CHORD_NAMES[idx + 1] : ALL_CHORD_NAMES[0];
      setDiagramChord(next);
    });

    $('cd-lookup-btn').addEventListener('click', () => {
      const val = $('cd-chord-input').value.trim();
      if (val) setDiagramChord(val);
    });
    $('cd-chord-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('cd-lookup-btn').click();
    });

    const grid = $('cd-browse-grid');
    const commonChords = ['C','D','E','F','G','A','B','Am','Bm','Cm','Dm','Em','Fm','Gm','C7','D7','E7','G7','A7','B7','Cmaj7','Dmaj7','Fmaj7','Gmaj7','Amaj7','Em7','Am7','Bm7','Dm7','Fdim','Gdim','Adim','Bdim','Caug','Daug','Eaug','Aaug','Dsus4','Esus4','Gsus4','Asus4','Cadd9','Dadd9','Eadd9','Gadd9','Aadd9'];
    grid.innerHTML = commonChords.map(ch => `<button class="cd-browse-btn" data-chord="${ch}">${ch}</button>`).join('');
    grid.querySelectorAll('.cd-browse-btn').forEach(btn => {
      btn.addEventListener('click', () => setDiagramChord(btn.dataset.chord));
    });
  }

  panel.style.display = 'flex';
  setDiagramChord(initialChord || 'C');
}

function setDiagramChord(name) {
  const nameEl = $('cd-chord-name');
  const inputEl = $('cd-chord-input');
  const wrap = $('cd-fretboard-wrap');
  if (nameEl) nameEl.textContent = name;
  if (inputEl) inputEl.value = name;
  if (wrap) renderFretboard(wrap, name);
  document.querySelectorAll('.cd-browse-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.chord === name);
  });
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
  if (song.key) text += `Key: ${song.key}\n\n`;
  song.sections.forEach(section => {
    text += `[${section.type}]\n`;
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
  if (song.key) md += `_Key: ${song.key}_\n\n`;
  song.sections.forEach(section => {
    md += `## ${section.type}\n\n`;
    section.lines.forEach(line => {
      const cs = line.chords.sort((a,b) => a.x-b.x).map(c => c.name).join(' ');
      if (cs) md += `  ${cs}  \n`;
      md += line.text + '\n\n';
    });
  });
  return md;
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
    s: (song.sections || []).map(sec => ({
      y: sec.type,
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
            <span class="share-opt-icon">📤</span>
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
    });
  };

  // Copy to clipboard
  $('share-clip-btn').onclick = () => {
    navigator.clipboard.writeText(code).then(() => {
      toast('Share code copied to clipboard');
      sheet.style.display = 'none';
    });
  };

  // Copy code button in the code area
  $('share-copy-code-btn').onclick = () => {
    navigator.clipboard.writeText(code).then(() => toast('Copied'));
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
    template: `{title: {{title}}}{#key}{key: {{key}}}{{/key}}\n\n{{#sections}}{{#type}}{{{type}}}{{/type}}\n{{#lines}}{{#chords}}{{name}}{{/chords}}{{text}}\n{{/lines}}\n{{/sections}}`
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
    localStorage.setItem('sn_export_plugins', JSON.stringify(plugins));
  } catch (e) {}
}

// Simple template engine
function renderPluginTemplate(template, song) {
  // Special: {{json}} outputs the whole song as JSON
  if (template.includes('{{json}}')) {
    return template.replace('{{json}}', JSON.stringify(song, null, 2));
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
      if (!confirm('Delete this plugin?')) return;
      const filtered = plugins.filter(p => p.id !== btn.dataset.id);
      savePlugins(filtered);
      renderPluginList();
      toast('Plugin deleted');
    };
  });
}

// Import
function importFiles() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.txt,.md,.text';
  inp.onchange = async e => {
    let n = 0;
    for (const file of e.target.files) {
      try {
        const content = await file.text();
        const name = file.name.replace(/\.[^.]+$/, '');
        songs.unshift(parseImported(name, content)); n++;
      } catch (err) {}
    }
    await saveSongs(); renderSongList(); toast(`Imported ${n} song${n !== 1 ? 's' : ''}`);
  };
  inp.click();
}

function parseImported(title, content) {
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

  return { id, title, key, bpm: null, time_sig: null, tags: [], folder: null, sections, audio: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
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
    ]}
  ];
  data.forEach(d => {
    const song = createSong(d.title);
    song.key = d.key || ''; song.bpm = d.bpm || null;
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
  const name = prompt('Song title:', '');
  if (name === null) return;
  
  let templateKey = 'Blank';
  // Ask for template after title
  const tmplKeys = Object.keys(SONG_TEMPLATES);
  const tmplChoice = prompt(`Choose template:\n1: ${tmplKeys[0]}\n2: ${tmplKeys[1]}\n3: ${tmplKeys[2]}\n4: ${tmplKeys[3]}`, '1');
  
  if (tmplChoice !== null) {
    const idx = parseInt(tmplChoice) - 1;
    if (idx >= 0 && idx < tmplKeys.length) templateKey = tmplKeys[idx];
  }
  
  const song = createSong(name || 'Untitled');
  const template = SONG_TEMPLATES[templateKey];
  if (template) {
    song.sections = template.sections.map(s => ({
      type: s.type,
      lines: s.lines.map(l => ({ text: l.text, chords: [] }))
    }));
  }
  songs.unshift(song); saveSingleSong(song);
  renderSongList(); currentSongId = song.id; openEditor(currentSongId); pushView('editor-view');
}

// ===== Setlist Mode =====

function loadSetlists() {
  try { setlists = JSON.parse(localStorage.getItem('sn_setlists') || '[]'); } catch { setlists = []; }
}

function saveSetlists() {
  localStorage.setItem('sn_setlists', JSON.stringify(setlists));
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
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><h2>No Setlists</h2><p>Tap + to create one</p></div>';
    return;
  }
  el.innerHTML = setlists.map(sl => {
    const count = sl.songs.length;
    return `<div class="setlist-item" data-id="${sl.id}">
      <span class="setlist-item-icon">📋</span>
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
      if (confirm(`Delete setlist "${sl.name}"?`)) {
        setlists = setlists.filter(s => s.id !== id);
        if (activeSetlistId === id) activeSetlistId = null;
        saveSetlists();
        renderSetlistList();
      }
    });
  });
}

function createNewSetlist() {
  const name = prompt('Setlist name:');
  if (!name || !name.trim()) return;
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
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">♪</div><h2>Empty Setlist</h2><p>Tap + to add songs</p></div>';
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
      if (song && !confirm(`Remove "${song.title}" from setlist?`)) return;
      setlist.songs.splice(idx, 1);
      saveSetlists();
      renderSetlistSongs();
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
  if (!sheet || !list) return;

  list.innerHTML = songs.map(s => {
    const alreadyIn = setlist.songs.some(ss => ss.songId === s.id);
    const lineCount = (s.sections||[]).reduce((a, sec) => a + sec.lines.length, 0);
    return `<div class="song-picker-item${alreadyIn ? ' already-in' : ''}" data-id="${s.id}">
      <div style="flex:1;min-width:0;">
        <div class="song-picker-title">${esc(s.title || 'Untitled')}</div>
        <div class="song-picker-meta">${s.key || 'No key'} · ${lineCount} lines</div>
      </div>
      ${alreadyIn ? '<span style="color:var(--fg-tertiary);font-size:13px;">Added</span>' : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('.song-picker-item:not(.already-in)').forEach(item => {
    item.addEventListener('click', () => {
      const songId = item.dataset.id;
      setlist.songs.push({ songId, capo: 0, transpose: 0 });
      saveSetlists();
      renderSetlistSongs();
      sheet.style.display = 'none';
      toast('Added to setlist');
    });
  });

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

    // Build transposed copy for display
    const displaySong = JSON.parse(JSON.stringify(song));
    if (entry.transpose) transposeSetlistSongData(displaySong, entry.transpose);

    html += `<div class="pp-song-block">`;
    html += `<div class="pp-song-title">${idx + 1}. ${esc(song.title || 'Untitled')}`;
    if (entry.capo) html += ` <span class="pp-song-capo">(Capo ${entry.capo})</span>`;
    if (entry.transpose) html += ` <span class="pp-song-capo">(${entry.transpose > 0 ? '+' : ''}${entry.transpose})</span>`;
    html += `</div>`;

    displaySong.sections.forEach(section => {
      html += `<div class="pp-section-type">${esc(section.type)}</div>`;
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

// Events
function setupEvents() {
  $('back-to-folders').addEventListener('click', popView);
  $('back-to-songs').addEventListener('click', () => saveCurrentSongAndGoBack());

  function saveCurrentSongAndGoBack() {
    const song = getSong(currentSongId);
    if (song) {
      if (versionHistory.length === 0 && !hasChanges) { /* nothing to save */ }
      song.title = $('song-title').value || 'Untitled';
      song.updated_at = new Date().toISOString();
      saveSingleSong(song);
    }
    popView(); renderSongList();
  }

  $('new-folder-btn').addEventListener('click', () => {
    const name = prompt('Folder name:');
    if (name && name.trim()) { folders.push(name.trim()); persistFolders(); renderFolders(); }
  });

  $('new-song-btn').addEventListener('click', () => {
    showNewSongMenu();
  });

  // Debounced search: avoid rebuilding DOM on every keystroke
  let searchTimer = 0;
  $('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSongList(e.target.value), 150);
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

  // Recording
  $('record-btn').addEventListener('click', async () => {
    if (isRecording) { stopRecording(); return; }
    if (!getSong(currentSongId)) { toast('Open a song first'); return; }
    pushVersion();
    await startRecording();
  });

  $('recordings-btn').addEventListener('click', toggleRecordingsDropdown);
  $('close-hist').addEventListener('click', () => $('history-panel').style.display = 'none');

  // Add section
  $('add-section-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return;
    pushVersion();
    song.sections.push({ type: 'Chorus', lines: [{ text: '', chords: [] }] });
    saveSingleSong(song); renderEditorBody(song);
    $('song-body').scrollTop = $('song-body').scrollHeight;
  });

  // Transpose
  $('transpose-down-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return; pushVersion();
    transposeSong(song, -1); saveSingleSong(song); renderEditorBody(song); toast('♭');
  });
  $('transpose-up-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return; pushVersion();
    transposeSong(song, 1); saveSingleSong(song); renderEditorBody(song); toast('♯');
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
      const a = btn.dataset.action;
      const song = getSong(currentSongId);

      if (a === 'set-key') {
        if (!song) return;
        const key = prompt('Key (e.g. G, Am):', song.key || '');
        if (key !== null) { song.key = key.trim(); await saveSingleSong(song); renderSongList(); }
      } else if (a === 'set-bpm') {
        if (!song) return;
        const bpm = prompt('BPM:', song.bpm || '');
        if (bpm !== null) { song.bpm = parseInt(bpm) || null; await saveSingleSong(song); }
      } else if (a === 'import-txt') {
        importFiles();
      } else if (a === 'export-txt') {
        if (!song) return; downloadFile(buildExportText(song), `${song.title || 'song'}.txt`, 'text/plain'); toast('Exported');
      } else if (a === 'export-md') {
        if (!song) return; downloadFile(buildExportMarkdown(song), `${song.title || 'song'}.md`, 'text/markdown'); toast('Exported');
      } else if (a === 'export-clip') {
        if (!song) return; navigator.clipboard.writeText(buildExportText(song)).then(() => toast('Copied'));
      } else if (a === 'history') {
        const panel = $('history-panel');
        if (panel) panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
      } else if (a === 'delete') {
        if (!song) return;
        if (confirm(`Delete "${song.title}"?`)) { await deleteSong(currentSongId); currentSongId = null; popView(); renderSongList(); toast('Deleted'); }
      } else if (a === 'setlist') {
        showSetlistView();
      } else if (a === 'share-song') {
        showShareSheet();
      } else if (a === 'plugins') {
        showPluginSheet();
      } else if (a === 'metronome') {
        showMetronomePanel();
      } else if (a === 'song-stats') {
        showSongStatsPanel();
      }
    });
  });

  // Close sheet on backdrop tap
  document.querySelector('.toolbar-sheet-backdrop')?.addEventListener('click', hideToolbarSheet);

  // ===== Metronome Events =====

  // Play/stop
  $('metro-play-btn')?.addEventListener('click', () => {
    if (metroPlaying) metroStop(); else metroStart();
  });

  // BPM up/down
  $('metro-bpm-down')?.addEventListener('click', () => metroSetBpm(metroBpm - 1));
  $('metro-bpm-up')?.addEventListener('click', () => metroSetBpm(metroBpm + 1));

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

  function showToolbarSheet() {
    const sheet = $('toolbar-sheet');
    if (sheet) sheet.style.display = 'flex';
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
    if (!e.target.closest('.popover') && !e.target.closest('#toolbar-more-btn')) {
      document.querySelectorAll('.popover').forEach(m => m.style.display = 'none');
    }
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoVersion(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault(); const song = getSong(currentSongId);
      if (song) { pushVersion(); song.title = $('song-title').value || 'Untitled'; song.updated_at = new Date().toISOString(); saveSingleSong(song); toast('Saved'); }
    }
  });

  // Mobile keyboard handling
  initMobileKeyboard();

  setupFolderActions();
  
  // Theme toggle
  $('theme-toggle')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('sn_app_theme', next);
    $('theme-toggle').textContent = next === 'dark' ? '☀️' : '🌙';
  });
  
  // Info panel toggle
  $('info-btn')?.addEventListener('click', () => {
    const bar = $('info-bar');
    if (bar.style.display === 'none' || !bar.style.display) {
      updateInfoBar();
      bar.style.display = 'flex';
    } else {
      bar.style.display = 'none';
    }
  });
  
  // View toggle (list / gallery)
  let galleryMode = false;
  $('view-toggle')?.addEventListener('click', () => {
    galleryMode = !galleryMode;
    const list = $('song-list');
    list.classList.toggle('gallery', galleryMode);
    $('view-toggle').textContent = galleryMode ? '☰' : '⊞';
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
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
  
  bar.innerHTML = `<span>${lineCount} lines · ${wordCount} words · ${chordCount} chords</span><span>Created ${created} · Modified ${updated}</span>`;
};

// Init
async function init() {
  await initTauri();
  await loadSongs();

  // Restore theme
  const savedTheme = localStorage.getItem('sn_app_theme') || 'dark';
  applyTheme(savedTheme);

  try { const s = JSON.parse(localStorage.getItem('folders_app')); if (s?.length) folders = s; } catch {}
  if (isTauri) { const bf = await tauriLoadFolders(); if (bf?.length) folders = bf; }

  addSampleSongs();
  
  // Remember last opened song
  const lastId = localStorage.getItem('songs_app_last');
  if (lastId && getSong(lastId)) {
    currentSongId = lastId;
  }
  
  renderFolders();
  setupEvents();
}

// ===== Metronome Engine =====

function metroGetCtx() {
  if (!metroAudioCtx) {
    metroAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (metroAudioCtx.state === 'suspended') {
    metroAudioCtx.resume();
  }
  return metroAudioCtx;
}

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

function metroScheduleNote() {
  const ctx = metroGetCtx();
  const secondsPerBeat = 60.0 / metroBpm;
  while (metroNextNoteTime < ctx.currentTime + metroLookahead / 1000) {
    const isAccent = (metroBeatIndex % metroTimeSig) === 0;
    metroPlayClick(isAccent);

    // Visual beat
    const beatTime = metroNextNoteTime;
    const delay = Math.max(0, (beatTime - ctx.currentTime) * 1000);
    setTimeout(() => {
      const circle = $('metro-beat-circle');
      if (!circle) return;
      circle.classList.remove('beat', 'beat-accent');
      void circle.offsetWidth; // force reflow
      circle.classList.add(isAccent ? 'beat-accent' : 'beat');
      setTimeout(() => circle.classList.remove('beat', 'beat-accent'), 100);
    }, delay);

    metroNextNoteTime += secondsPerBeat;
    metroBeatIndex++;
  }
}

function metroStart() {
  if (metroPlaying) return;
  metroPlaying = true;
  metroBeatIndex = 0;
  const ctx = metroGetCtx();
  metroNextNoteTime = ctx.currentTime + 0.05;
  metroTimerID = setInterval(metroScheduleNote, metroSchedulerInterval);

  const playBtn = $('metro-play-btn');
  if (playBtn) {
    playBtn.textContent = '■';
    playBtn.classList.add('playing');
  }
}

function metroStop() {
  metroPlaying = false;
  if (metroTimerID) {
    clearInterval(metroTimerID);
    metroTimerID = null;
  }
  const playBtn = $('metro-play-btn');
  if (playBtn) {
    playBtn.textContent = '▶';
    playBtn.classList.remove('playing');
  }
  const circle = $('metro-beat-circle');
  if (circle) circle.classList.remove('beat', 'beat-accent');
}

function metroSetBpm(val) {
  metroBpm = Math.max(30, Math.min(240, val));
  const el = $('metro-bpm-value');
  if (el) el.textContent = metroBpm;
  const slider = $('metro-bpm-slider');
  if (slider) slider.value = metroBpm;
  // Update preset active state
  document.querySelectorAll('.metro-preset-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.bpm) === metroBpm);
  });
}

function metroSetTimeSig(val) {
  metroTimeSig = val;
  document.querySelectorAll('.metro-time-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.sig) === val);
  });
}

function showMetronomePanel() {
  const panel = $('metronome-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  metroSetBpm(metroBpm);
  metroSetTimeSig(metroTimeSig);

  // Close on backdrop tap
  panel.querySelector('.toolbar-sheet-backdrop').onclick = () => {
    metroStop();
    panel.style.display = 'none';
  };
}

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
    body.innerHTML = '<div class="stats-empty"><div class="stats-empty-icon">📊</div><div>Select a song to view statistics</div></div>';
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