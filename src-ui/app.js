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
    audio: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString()
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
  autoSaveTimer = setTimeout(async () => {
    if (!song) return;
    song.updated_at = new Date().toISOString();
    await saveSingleSong(song);
    hasChanges = false;
    $('save-btn').disabled = true;
  }, 1200);
}

// Folders
function renderFolders() {
  const el = $('folder-list');
  el.innerHTML = folders.map(f => {
    const count = f === 'All Songs' ? songs.length : songs.filter(s => s.folder === f).length;
    const cls = f === currentFolder ? 'list-item active' : 'list-item';
    const icon = f === 'All Songs' ? '♫' : '♪';
    return `<div class="${cls}" data-folder="${esc(f)}"><span class="item-icon">${icon}</span><span class="item-title">${esc(f)}</span><span class="item-meta">${count}</span>${f !== 'All Songs' ? '<span class="folder-dots">⋯</span>' : ''}</div>`;
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

// Song list
function renderSongList(filter = '') {
  const el = $('song-list');
  let list = currentFolder === 'All Songs' ? songs : songs.filter(s => s.folder === currentFolder);
  if (filter) { const q = filter.toLowerCase(); list = list.filter(s => s.title?.toLowerCase().includes(q)); }
  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">♪</div><h2>No Songs</h2><p>Tap + to create one</p></div>';
    return;
  }
  el.innerHTML = list.map(s => `<div class="list-item" data-id="${s.id}"><span class="item-title">${esc(s.title || 'Untitled')}${s.key ? `<span class="item-key">${esc(s.key)}</span>` : ''}</span><span class="item-meta">${fmtDate(s.updated_at)}</span></div>`).join('');
  el.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => { currentSongId = item.dataset.id; openEditor(currentSongId); pushView('editor-view'); });
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

  const textArea = document.createElement('div');
  textArea.className = 'lyric-text';
  textArea.contentEditable = true;
  textArea.dataset.placeholder = 'Lyrics';
  textArea.textContent = line.text;

  textArea.addEventListener('input', () => {
    line.text = textArea.textContent;
    triggerAutoSave(song);
  });

  // Render chord placeholders above the text
  function renderChords() {
    lineEl.querySelectorAll('.chord-placeholder').forEach(e => e.remove());
    line.chords.forEach(ch => {
      const span = document.createElement('span');
      span.className = 'chord-placeholder';
      span.textContent = ch.name;
      span.style.left = ch.x + 'px';
      span.addEventListener('click', e => { e.stopPropagation(); showChordEdit(song, line, ch); });
      lineEl.appendChild(span);
    });
  }

  // Click on the line background (not the text) to add a chord
  lineEl.addEventListener('click', e => {
    // Only add chord when clicking on the line background, NOT on the textArea or existing chords
    if (e.target === lineEl) {
      const rect = lineEl.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      if (line.chords.find(c => Math.abs(c.x - x) < 20)) return;
      const chord = { x, name: '' };
      line.chords.push(chord);
      line.chords.sort((a, b) => a.x - b.x);
      saveSingleSong(song);
      renderChords();
      showChordEdit(song, line, chord);
    }
  });

  lineEl.appendChild(textArea);
  const addBtn = container.lastElementChild;
  if (addBtn && addBtn.classList.contains('add-line-btn')) container.insertBefore(lineEl, addBtn);
  else container.appendChild(lineEl);
  renderChords();
}

// Chord Popup
let chordPopup = null;
function showChordEdit(song, line, chord) {
  if (chordPopup) chordPopup.remove();
  chordPopup = document.createElement('div');
  chordPopup.className = 'chord-popup';
  const input = document.createElement('input');
  input.value = chord.name; input.placeholder = 'Am'; input.autofocus = true; input.spellcheck = false;
  const doneBtn = document.createElement('button');
  doneBtn.className = 'done-btn'; doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => {
    chord.name = input.value.trim();
    line.chords.sort((a, b) => a.x - b.x);
    saveSingleSong(song);
    chordPopup.remove(); chordPopup = null;
  });
  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn'; removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    line.chords = line.chords.filter(c => c !== chord);
    saveSingleSong(song);
    chordPopup.remove(); chordPopup = null;
  });
  chordPopup.appendChild(input); chordPopup.appendChild(doneBtn); chordPopup.appendChild(removeBtn);
  document.body.appendChild(chordPopup); input.focus();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doneBtn.click(); });
  const closeOnOutside = e => { if (chordPopup && !chordPopup.contains(e.target)) { chordPopup.remove(); chordPopup = null; document.removeEventListener('click', closeOnOutside); } };
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
    const name = prompt('Song title:');
    if (name === null) return;
    const song = createSong(name || 'Untitled');
    songs.unshift(song); saveSingleSong(song);
    renderSongList(); currentSongId = song.id; openEditor(currentSongId); pushView('editor-view');
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

  // More menu
  $('toolbar-more-btn').addEventListener('click', e => {
    e.stopPropagation();
    const menu = $('more-menu');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  });

  $('more-menu').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      $('more-menu').style.display = 'none';
      const a = btn.dataset.action;
      const song = getSong(currentSongId);

      if (a === 'set-key') {
        if (!song) return;
        const key = prompt('Key (e.g. G, Am):', song.key || '');
        if (key !== null) { song.key = key.trim(); btn.textContent = song.key ? `Set Key: ${song.key}` : 'Set Key: —'; await saveSingleSong(song); renderSongList(); }
      } else if (a === 'import-txt') {
        importFiles();
      } else if (a === 'export-txt') {
        if (!song) return; downloadFile(buildExportText(song), `${song.title || 'song'}.txt`, 'text/plain'); toast('Exported');
      } else if (a === 'export-md') {
        if (!song) return; downloadFile(buildExportMarkdown(song), `${song.title || 'song'}.md`, 'text/markdown'); toast('Exported');
      } else if (a === 'export-clip') {
        if (!song) return; navigator.clipboard.writeText(buildExportText(song)).then(() => toast('Copied'));
      } else if (a === 'delete') {
        if (!song) return;
        if (confirm(`Delete "${song.title}"?`)) { await deleteSong(currentSongId); currentSongId = null; popView(); renderSongList(); toast('Deleted'); }
      }
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
}

// Init
async function init() {
  await initTauri();
  await loadSongs();

  try { const s = JSON.parse(localStorage.getItem('folders_app')); if (s?.length) folders = s; } catch {}
  if (isTauri) { const bf = await tauriLoadFolders(); if (bf?.length) folders = bf; }

  addSampleSongs();
  renderFolders();
  setupEvents();
}

init();