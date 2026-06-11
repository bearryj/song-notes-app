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
  saveSingleSong(song); openEditor(currentSongId); toast('Restored');
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
      const song = getSong(currentSongId);
      if (!song) return;
      song.key = v.key; song.sections = v.sections;
      saveSingleSong(song); openEditor(currentSongId); toast('Restored');
      $('history-panel').style.display = 'none';
    });
  });
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
function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
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

  $('search-input').addEventListener('input', e => renderSongList(e.target.value));

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
      }
    });
  });

  // Close sheet on backdrop tap
  document.querySelector('.toolbar-sheet-backdrop')?.addEventListener('click', hideToolbarSheet);

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

init();