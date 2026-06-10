// ===== Song Notes Mobile — Feature Complete =====

import { invoke } from '@tauri-apps/api/core';

let isTauri = false;
let songs = [];
let folders = ['All Songs'];
let currentFolder = 'All Songs';
let currentSongId = null;
let viewStack = ['folder-view'];
let autoSaveTimer = null;

// ===== Version History =====
let versionHistory = [];
let dragSrcSection = null;

// ===== Audio =====
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let audioPlayer = new Audio();

// ===== Chord Definitions =====
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROMATIC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function noteToSemitone(note) {
  const n = note.toUpperCase();
  const idx = CHROMATIC.indexOf(n);
  if (idx !== -1) return idx;
  return CHROMATIC_FLAT.indexOf(n);
}

function semitoneToNote(s, useFlats) {
  const scale = useFlats ? CHROMATIC_FLAT : CHROMATIC;
  return scale[((s % 12) + 12) % 12];
}

function transposeChord(chordName, semitones) {
  if (!chordName || !chordName.trim()) return chordName;
  const m = chordName.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return chordName;
  const note = m[1];
  const suffix = m[2];
  const idx = noteToSemitone(note);
  if (idx === -1) return chordName;
  return semitoneToNote(idx + semitones) + suffix;
}

function transposeSong(song, semitones) {
  song.sections.forEach(section => {
    section.lines.forEach(line => {
      line.chords.forEach(ch => {
        ch.name = transposeChord(ch.name, semitones);
      });
    });
  });
  if (song.key) {
    const keyMatch = song.key.match(/^([A-G][#b]?)(.*)$/);
    if (keyMatch) {
      const idx = noteToSemitone(keyMatch[1]);
      if (idx !== -1) {
        song.key = semitoneToNote(idx + semitones) + keyMatch[2];
      }
    }
  }
}

// ===== DOM refs =====
const $ = id => document.getElementById(id);

// ===== Navigation =====
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}

function pushView(id) {
  viewStack.push(id);
  showView(id);
}

function popView() {
  if (viewStack.length > 1) {
    viewStack.pop();
    showView(viewStack[viewStack.length - 1]);
  }
}

// ===== Init Tauri =====
async function initTauri() {
  try {
    await invoke('ensure_data_dir');
    isTauri = true;
  } catch (e) {
    isTauri = false;
  }
}

// ===== Tauri Backend Persistence =====
async function tauriLoadSongs() {
  try { const r = await invoke('load_songs'); return r || []; }
  catch (e) { return null; }
}

async function tauriSaveSong(song) {
  try { await invoke('save_song', { song }); return true; }
  catch (e) { return false; }
}

async function tauriDeleteSong(id) {
  try { await invoke('delete_song', { id }); return true; }
  catch (e) { return false; }
}

async function tauriLoadFolders() {
  try { return await invoke('load_folders'); }
  catch (e) { return null; }
}

async function tauriSaveFolders(folderList) {
  try { await invoke('save_folders', { folders: folderList }); return true; }
  catch (e) { return false; }
}

async function tauriReadFile(path) {
  try { return await invoke('read_file_content', { path }); }
  catch (e) { return null; }
}

// ===== Persistence =====
async function loadSongs() {
  if (isTauri) {
    const r = await tauriLoadSongs();
    if (r) { songs = r; return; }
  }
  try { songs = JSON.parse(localStorage.getItem('songs_app')) || []; }
  catch { songs = []; }
}

async function saveSongs() {
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) for (const s of songs) await tauriSaveSong(s);
}

async function saveSingleSong(song) {
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song;
  else songs.unshift(song);
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) await tauriSaveSong(song);
}

// ===== Song CRUD =====
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createSong(title = 'Untitled') {
  return {
    id: generateId(), title, key: '', bpm: null, time_sig: null,
    tags: [], folder: null,
    sections: [{ type: 'Verse 1', lines: [{ text: '', chords: [] }] }],
    audio: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}

function getSong(id) { return songs.find(s => s.id === id); }

async function deleteSong(id) {
  songs = songs.filter(s => s.id !== id);
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) await tauriDeleteSong(id);
}

// ===== Version History =====
function pushVersion() {
  if (!getSong(currentSongId)) return;
  const song = getSong(currentSongId);
  versionHistory.push({ ts: Date.now(), key: song.key, sections: JSON.parse(JSON.stringify(song.sections)) });
  if (versionHistory.length > 20) versionHistory.shift();
}

function undoVersion() {
  if (!versionHistory.length) { toast('No previous version'); return; }
  const prev = versionHistory.pop();
  const song = getSong(currentSongId);
  if (!song) return;
  song.key = prev.key;
  song.sections = prev.sections;
  saveSingleSong(song);
  openEditor(currentSongId);
  toast('Restored ✓');
}

function toggleHistory() {
  let panel = $('history-panel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  if (panel.style.display === 'flex') renderHistoryList();
}

function renderHistoryList() {
  const list = $('hist-list'); if (!list) return;
  if (!versionHistory.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--fg-tertiary);font-size:13px;">No versions yet.</div>';
    return;
  }
  list.innerHTML = [...versionHistory].reverse().map(v => `
    <div class="hist-item" data-ts="${v.ts}">
      <div class="hist-time">${new Date(v.ts).toLocaleTimeString()}</div>
      <div class="hist-meta">${v.key || 'No key'} · ${v.sections.reduce((a, s) => a + s.lines.length, 0)} lines</div>
    </div>
  `).join('');
  list.querySelectorAll('.hist-item').forEach(el => {
    el.addEventListener('click', () => {
      const ts = parseInt(el.dataset.ts);
      const v = versionHistory.find(x => x.ts === ts);
      if (!v) return;
      const song = getSong(currentSongId);
      if (!song) return;
      song.key = v.key;
      song.sections = v.sections;
      saveSingleSong(song);
      openEditor(currentSongId);
      toast('Restored ✓');
      $('history-panel').style.display = 'none';
    });
  });
}

// ===== Audio Recording =====
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const song = getSong(currentSongId);
        if (!song) return;
        if (!song.audio) song.audio = [];
        song.audio.push({ data: reader.result, ts: Date.now() });
        await saveSingleSong(song);
        updateRecordBtnUI();
        toast(`Recording saved (${song.audio.length} total)`);
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start();
    isRecording = true;
    updateRecordBtnUI();
    toast('Recording... tap ⏺ to stop');
  } catch (e) {
    toast('Microphone access denied', 'error');
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    updateRecordBtnUI();
  }
}

function updateRecordBtnUI() {
  const b = $('record-btn');
  b.textContent = isRecording ? '⏹' : '⏺';
  b.classList.toggle('recording', isRecording);
}

function playRecording(dataUrl) {
  if (!dataUrl) return;
  if (!audioPlayer.paused) { audioPlayer.pause(); audioPlayer.currentTime = 0; }
  audioPlayer.src = dataUrl;
  audioPlayer.play();
  document.querySelectorAll('.rec-item.recording-playing').forEach(i => i.classList.remove('recording-playing'));
  const item = document.querySelector(`.rec-item[data-url="${dataUrl}"]`);
  if (item) item.classList.add('recording-playing');
  audioPlayer.onended = () => {
    document.querySelectorAll('.rec-item.recording-playing').forEach(i => i.classList.remove('recording-playing'));
  };
}

function toggleRecordingsDropdown() {
  const existing = $('recordings-dropdown');
  if (existing.style.display !== 'none' && existing.innerHTML) {
    existing.style.display = 'none';
    return;
  }
  const song = getSong(currentSongId);
  const recordings = song?.audio || [];
  if (!recordings.length) { toast('No recordings'); return; }
  const dd = existing;
  const recList = $('rec-list');
  recList.innerHTML = [...recordings].reverse().map((rec, i) => {
    const idx = recordings.length - 1 - i;
    const date = new Date(rec.ts).toLocaleString();
    return `<div class="rec-item" data-url="${rec.data}" data-idx="${idx}">
      <span>Recording ${idx + 1}</span>
      <span style="font-size:11px;color:var(--fg-tertiary);">${date}</span>
      <button class="rec-play-btn" data-url="${rec.data}">▶</button>
    </div>`;
  }).join('');
  recList.querySelectorAll('.rec-play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); playRecording(btn.dataset.url); });
  });
  recList.querySelectorAll('.rec-item').forEach(item => {
    item.addEventListener('click', () => playRecording(item.dataset.url));
  });
  $('delete-all-recordings').onclick = () => {
    if (!confirm('Delete all recordings?')) return;
    const s = getSong(currentSongId);
    if (s) { s.audio = []; saveSingleSong(s); }
    dd.style.display = 'none';
    toast('Recordings deleted');
  };
  dd.style.display = 'block';
}

// ===== Render Helpers =====
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleDateString();
}

// ===== Auto-Save =====
function triggerAutoSave(song) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    if (!song) return;
    song.updated_at = new Date().toISOString();
    await saveSingleSong(song);
  }, 800);
}

// ===== Render Folder List =====
function renderFolders() {
  const el = $('folder-list');
  el.innerHTML = folders.map(f => {
    const count = f === 'All Songs' ? songs.length : songs.filter(s => s.folder === f).length;
    return `<div class="list-item folder-item" data-folder="${escapeHtml(f)}">
      <span class="item-icon">📁</span>
      <span class="item-title">${escapeHtml(f)}</span>
      <span class="item-meta">${count}</span>
      ${f !== 'All Songs' ? '<span class="folder-dots">⋯</span>' : ''}
    </div>`;
  }).join('');

  el.querySelectorAll('.folder-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.folder-dots')) return;
      currentFolder = item.dataset.folder;
      $('folder-title').textContent = currentFolder;
      renderSongList();
      pushView('song-list-view');
    });
    const dots = item.querySelector('.folder-dots');
    if (dots) {
      dots.addEventListener('click', (e) => {
        e.stopPropagation();
        showFolderActions(item.dataset.folder, dots);
      });
    }
  });
}

// ===== Folder Actions =====
let activeFolderName = '';

function showFolderActions(folderName, anchorEl) {
  activeFolderName = folderName;
  const menu = $('folder-actions');
  const rect = anchorEl.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = '16px';
  menu.style.display = 'block';
}

function setupFolderActions() {
  $('folder-actions').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      $('folder-actions').style.display = 'none';
      const action = btn.dataset.action;
      if (action === 'rename') {
        const name = prompt('New folder name:', activeFolderName);
        if (name && name.trim() && name !== activeFolderName) {
          const idx = folders.indexOf(activeFolderName);
          if (idx >= 0) {
            folders[idx] = name.trim();
            // Update songs in this folder
            songs.forEach(s => { if (s.folder === activeFolderName) s.folder = name.trim(); });
            saveSongs();
            persistFolders();
            renderFolders();
          }
        }
      } else if (action === 'delete-folder') {
        if (confirm(`Delete folder "${activeFolderName}"? Songs will be moved to "All Songs".`)) {
          songs.forEach(s => { if (s.folder === activeFolderName) s.folder = null; });
          folders = folders.filter(f => f !== activeFolderName);
          saveSongs();
          persistFolders();
          renderFolders();
        }
      }
    });
  });
}

async function persistFolders() {
  localStorage.setItem('folders_app', JSON.stringify(folders));
  if (isTauri) await tauriSaveFolders(folders);
}

// ===== Render Song List =====
function renderSongList(filter = '') {
  const el = $('song-list');
  let list = currentFolder === 'All Songs'
    ? songs : songs.filter(s => s.folder === currentFolder);

  if (filter) {
    const q = filter.toLowerCase();
    list = list.filter(s => s.title.toLowerCase().includes(q));
  }

  if (list.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div><h2>No songs</h2><p>Tap + to create a song</p></div>';
    return;
  }

  el.innerHTML = list.map(s => `
    <div class="list-item" data-id="${s.id}">
      <span class="item-title">${escapeHtml(s.title)}${s.key ? ` <span class="item-key">${escapeHtml(s.key)}</span>` : ''}</span>
      <span class="item-meta">${formatDate(s.updated_at)}</span>
    </div>
  `).join('');

  el.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => {
      currentSongId = item.dataset.id;
      openEditor(currentSongId);
      pushView('editor-view');
    });
  });
}

// ===== Open Editor =====
function openEditor(id) {
  const song = getSong(id);
  if (!song) return;
  $('song-title').value = song.title;
  versionHistory = [];
  renderEditorBody(song);
  updateMoreMenuKey(song);
  updateRecordBtnUI();
}

function updateMoreMenuKey(song) {
  const keyBtn = $('more-menu')?.querySelector('[data-action="set-key"]');
  if (keyBtn) keyBtn.textContent = song.key ? `Key: ${song.key}` : 'Key: None';
}

function renderEditorBody(song) {
  const el = $('song-body');
  el.innerHTML = '';
  song.sections.forEach((section, si) => {
    const tmpl = $('section-template').content.cloneNode(true);
    const sectionEl = tmpl.querySelector('.song-section');
    const typeSelect = tmpl.querySelector('.section-type');

    const opt = typeSelect.querySelector(`option[value="${escapeHtml(section.type)}"]`);
    if (opt) opt.selected = true;

    tmpl.querySelector('.delete-section').addEventListener('click', () => {
      if (song.sections.length <= 1) { toast('Need at least one section'); return; }
      song.sections.splice(si, 1);
      saveSingleSong(song);
      renderEditorBody(song);
    });

    typeSelect.addEventListener('change', () => {
      song.sections[si].type = typeSelect.value;
      triggerAutoSave(song);
    });

    // Section reorder - up
    tmpl.querySelector('.move-up').addEventListener('click', () => {
      if (si <= 0) return;
      [song.sections[si - 1], song.sections[si]] = [song.sections[si], song.sections[si - 1]];
      saveSingleSong(song); renderEditorBody(song);
    });

    // Section reorder - down
    tmpl.querySelector('.move-down').addEventListener('click', () => {
      if (si >= song.sections.length - 1) return;
      [song.sections[si], song.sections[si + 1]] = [song.sections[si + 1], song.sections[si]];
      saveSingleSong(song); renderEditorBody(song);
    });

    // Duplicate section
    tmpl.querySelector('.duplicate-section').addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(song.sections[si]));
      song.sections.splice(si + 1, 0, copy);
      saveSingleSong(song); renderEditorBody(song);
    });

    // Drag-to-reorder support
    sectionEl.addEventListener('dragstart', e => {
      dragSrcSection = sectionEl;
      sectionEl.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    sectionEl.addEventListener('dragover', e => { e.preventDefault(); sectionEl.classList.add('drag-over'); });
    sectionEl.addEventListener('dragleave', () => sectionEl.classList.remove('drag-over'));
    sectionEl.addEventListener('drop', e => {
      e.preventDefault();
      sectionEl.classList.remove('drag-over');
      if (dragSrcSection && dragSrcSection !== sectionEl) {
        const fromIdx = Array.from(el.children).indexOf(dragSrcSection);
        const toIdx = Array.from(el.children).indexOf(sectionEl);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [removed] = song.sections.splice(fromIdx, 1);
          song.sections.splice(toIdx, 0, removed);
          saveSingleSong(song);
        }
      }
      renderEditorBody(song);
    });
    sectionEl.addEventListener('dragend', () => { sectionEl.style.opacity = '1'; dragSrcSection = null; });

    // Section editor (lines)
    const editorDiv = tmpl.querySelector('.section-editor');
    section.lines.forEach((line, li) => {
      renderLine(editorDiv, song, si, li, line);
    });

    // Add line button
    const addLineBtn = document.createElement('button');
    addLineBtn.className = 'add-line-btn';
    addLineBtn.innerHTML = '+ Line';
    addLineBtn.addEventListener('click', () => {
      const newLine = { text: '', chords: [] };
      song.sections[si].lines.push(newLine);
      saveSingleSong(song);
      renderLine(editorDiv, song, si, song.sections[si].lines.length - 1, newLine);
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
  textArea.dataset.placeholder = 'Lyrics...';
  textArea.textContent = line.text;

  textArea.addEventListener('input', () => {
    line.text = textArea.textContent;
    triggerAutoSave(song);
  });

  function renderChords() {
    lineEl.querySelectorAll('.chord-placeholder').forEach(e => e.remove());
    line.chords.forEach(ch => {
      const span = document.createElement('span');
      span.className = 'chord-placeholder';
      span.textContent = ch.name;
      span.style.left = ch.x + 'px';
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        showChordEdit(song, line, ch);
      });
      lineEl.appendChild(span);
    });
  }

  lineEl.addEventListener('click', (e) => {
    if (e.target === lineEl || e.target === textArea) {
      const rect = lineEl.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      const existing = line.chords.find(c => Math.abs(c.x - x) < 20);
      if (existing) return;
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
  if (addBtn && addBtn.classList.contains('add-line-btn')) {
    container.insertBefore(lineEl, addBtn);
  } else {
    container.appendChild(lineEl);
  }
  renderChords();
}

// ===== Chord Edit Popup =====
let chordPopup = null;

function showChordEdit(song, line, chord) {
  if (chordPopup) chordPopup.remove();

  chordPopup = document.createElement('div');
  chordPopup.className = 'chord-popup';

  const input = document.createElement('input');
  input.value = chord.name;
  input.placeholder = 'e.g. Am';
  input.autofocus = true;
  input.spellcheck = false;

  const doneBtn = document.createElement('button');
  doneBtn.className = 'done-btn';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => {
    chord.name = input.value.trim();
    line.chords.sort((a, b) => a.x - b.x);
    saveSingleSong(song);
    if (chordPopup) { chordPopup.remove(); chordPopup = null; }
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    line.chords = line.chords.filter(c => c !== chord);
    saveSingleSong(song);
    if (chordPopup) { chordPopup.remove(); chordPopup = null; }
  });

  chordPopup.appendChild(input);
  chordPopup.appendChild(doneBtn);
  chordPopup.appendChild(removeBtn);
  document.body.appendChild(chordPopup);
  input.focus();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doneBtn.click();
  });

  setTimeout(() => {
    document.addEventListener('click', closePopupHandler = (e) => {
      if (chordPopup && !chordPopup.contains(e.target)) {
        chordPopup.remove();
        chordPopup = null;
        document.removeEventListener('click', closePopupHandler);
      }
    }, { once: true });
  }, 100);
}

// ===== Export =====
function buildExportText(song) {
  let text = song.title + '\n';
  text += '='.repeat(song.title.length) + '\n\n';
  if (song.key) text += `Key: ${song.key}\n`;
  text += '\n';
  song.sections.forEach(section => {
    text += `[${section.type}]\n`;
    section.lines.forEach(line => {
      if (line.chords.length > 0) {
        let chordLine = '';
        let lastX = 0;
        line.chords.forEach(ch => {
          const spaces = Math.max(0, Math.floor((ch.x - lastX) / 7));
          chordLine += ' '.repeat(spaces) + ch.name;
          lastX = ch.x + ch.name.length * 7;
        });
        if (chordLine.trim()) text += chordLine + '\n';
      }
      text += line.text + '\n';
    });
    text += '\n';
  });
  return text;
}

function buildExportMarkdown(song) {
  let md = `# ${song.title}\n\n`;
  if (song.key) md += `- **Key:** ${song.key}\n`;
  md += '\n';
  song.sections.forEach(section => {
    md += `## ${section.type}\n\n`;
    section.lines.forEach(line => {
      const chordStr = line.chords.sort((a, b) => a.x - b.x).map(c => c.name).join(' ');
      if (chordStr) md += `  ${chordStr}  \n`;
      md += `${line.text}\n\n`;
    });
  });
  return md;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Import =====
function importFiles() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = '.txt,.md,.text';
  inp.onchange = async e => {
    let n = 0;
    for (const file of e.target.files) {
      try {
        const content = await file.text();
        const name = file.name.replace(/\.[^.]+$/, '');
        songs.unshift(parseImported(name, content));
        n++;
      } catch (err) { console.error('Import failed:', file.name, err); }
    }
    await saveSongs();
    renderSongList();
    toast(`Imported ${n} song${n !== 1 ? 's' : ''}`);
  };
  inp.click();
}

function parseImported(title, content) {
  const id = generateId();
  const lines = content.split('\n').filter(l => l.trim());
  const sectionKeywords = ['verse', 'chorus', 'bridge', 'pre-chorus', 'outro', 'intro', 'hook', 'refrain'];
  const sections = [];
  let currentSection = { type: 'Verse 1', lines: [{ text: '', chords: [] }] };
  let lineIdx = 0;
  let hasSections = false;

  while (lineIdx < lines.length) {
    const trimmed = lines[lineIdx].trim();
    const lower = trimmed.toLowerCase().replace(/[^\w\s-]/g, '');

    let isSectionHeader = false;
    for (const kw of sectionKeywords) {
      if (lower === kw || lower.startsWith(kw + ' ') || new RegExp(`^${kw}\\s*\\d*$`).test(lower)) {
        if (currentSection.lines.length > 0 && currentSection.lines[0].text !== '') {
          sections.push({ ...currentSection, lines: currentSection.lines.filter(l => l.text !== '') });
        }
        let sectionType = kw.charAt(0).toUpperCase() + kw.slice(1);
        const numMatch = trimmed.match(/(\d+)/);
        if (numMatch) sectionType += ' ' + numMatch[1];
        currentSection = { type: sectionType, lines: [] };
        hasSections = true;
        isSectionHeader = true;
        break;
      }
    }

    if (!isSectionHeader && trimmed) {
      // Extract chords in [brackets] from the line
      const chordRegex = /\[([A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G][#b]?)?)\]/g;
      let match;
      let text = trimmed;
      const chords = [];
      while ((match = chordRegex.exec(text)) !== null) {
        chords.push({ x: match.index * 8, name: match[1] });
      }
      text = text.replace(chordRegex, '').trim();
      currentSection.lines.push({ text, chords });
    }
    lineIdx++;
  }

  if (currentSection.lines.length > 0 && currentSection.lines[0].text !== '') {
    sections.push({ ...currentSection, lines: currentSection.lines.filter(l => l.text !== '') });
  }

  if (!hasSections || sections.length === 0) {
    sections.push({ type: 'Verse 1', lines: [{ text: content, chords: [] }] });
  }

  let key = '';
  const keyMatch = content.match(/\bkey[:\s]+([A-G][#b]?m?)\b/i);
  if (keyMatch) key = keyMatch[1];

  return { id, title, key, bpm: null, time_sig: null, tags: [], folder: null, sections, audio: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

// ===== Toast =====
function toast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// ===== Sample Songs =====
function addSampleSongs() {
  if (songs.length > 0) return;

  const samples = [
    {
      title: 'Blinding Lights', key: 'F#m', bpm: 171,
      sections: [
        { type: 'Intro', lines: [
          { text: 'Yeah, yeah', chords: [{ x: 10, name: 'F#m' }] },
          { text: '', chords: [] }
        ]},
        { type: 'Verse 1', lines: [
          { text: "I've been tryna call", chords: [{ x: 10, name: 'F#m' }] },
          { text: "I've been on my own for long enough", chords: [{ x: 60, name: 'D' }] },
          { text: 'Maybe you can show me how to love', chords: [{ x: 120, name: 'A' }] },
          { text: "Maybe I'm going through withdrawals", chords: [{ x: 180, name: 'E' }] }
        ]},
        { type: 'Chorus', lines: [
          { text: "I said, ooh, I'm blinded by the lights", chords: [{ x: 10, name: 'F#m' }, { x: 180, name: 'D' }] },
          { text: "No, I can't sleep until I feel your touch", chords: [{ x: 60, name: 'A' }, { x: 180, name: 'E' }] }
        ]}
      ]
    },
    {
      title: 'Hallelujah', key: 'C',
      sections: [
        { type: 'Verse 1', lines: [
          { text: "I've heard there was a secret chord", chords: [{ x: 10, name: 'C' }, { x: 180, name: 'Am' }] },
          { text: 'That David played and it pleased the Lord', chords: [{ x: 10, name: 'C' }, { x: 180, name: 'Am' }] },
          { text: "But you don't really care for music, do ya?", chords: [{ x: 10, name: 'F' }, { x: 100, name: 'G' }, { x: 200, name: 'C' }, { x: 280, name: 'G' }] },
          { text: 'It goes like this: the fourth, the fifth', chords: [{ x: 10, name: 'C' }, { x: 120, name: 'F' }, { x: 200, name: 'G' }] },
          { text: 'The minor fall, the major lift', chords: [{ x: 10, name: 'Am' }, { x: 150, name: 'F' }] },
          { text: 'The baffled king composing Hallelujah', chords: [{ x: 10, name: 'G' }, { x: 130, name: 'E7' }, { x: 230, name: 'Am' }] }
        ]},
        { type: 'Chorus', lines: [
          { text: 'Hallelujah, Hallelujah', chords: [{ x: 10, name: 'F' }] },
          { text: 'Hallelujah, Hallelu-u-u-jah', chords: [{ x: 10, name: 'Am' }, { x: 180, name: 'F' }, { x: 250, name: 'C' }, { x: 320, name: 'G' }] }
        ]}
      ]
    },
    {
      title: 'New Song Idea', key: 'G', bpm: 120,
      sections: [
        { type: 'Verse 1', lines: [
          { text: 'Write your lyrics here', chords: [{ x: 10, name: 'G' }] },
          { text: 'Tap to add chords', chords: [{ x: 60, name: 'C' }] },
          { text: 'Keep writing...', chords: [{ x: 120, name: 'D' }] }
        ]},
        { type: 'Chorus', lines: [
          { text: 'This is the chorus', chords: [{ x: 10, name: 'G' }, { x: 120, name: 'Em' }] },
          { text: 'Catchy and repeatable', chords: [{ x: 10, name: 'C' }, { x: 150, name: 'D' }] }
        ]}
      ]
    }
  ];

  samples.forEach(data => {
    const song = createSong(data.title);
    song.key = data.key || '';
    song.bpm = data.bpm || null;
    song.sections = data.sections.map(s => ({
      type: s.type,
      lines: s.lines.map(l => ({ text: l.text, chords: l.chords.map(c => ({ x: c.x, name: c.name })) }))
    }));
    songs.push(song);
  });
  saveSongs();
}

// ===== Event Setup =====
function setupEvents() {
  // Back buttons
  $('back-to-folders').addEventListener('click', popView);
  $('back-to-songs').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (song) {
      song.title = $('song-title').value || 'Untitled';
      song.updated_at = new Date().toISOString();
      saveSingleSong(song);
    }
    popView();
    renderSongList();
  });

  // New folder
  $('new-folder-btn').addEventListener('click', () => {
    const name = prompt('Folder name:');
    if (name && name.trim()) {
      folders.push(name.trim());
      persistFolders();
      renderFolders();
    }
  });

  // New song
  $('new-song-btn').addEventListener('click', () => {
    const name = prompt('Song title:');
    if (name === null) return;
    const song = createSong(name || 'Untitled');
    songs.unshift(song);
    saveSingleSong(song);
    renderSongList();
    currentSongId = song.id;
    openEditor(currentSongId);
    pushView('editor-view');
  });

  // Search
  $('search-input').addEventListener('input', (e) => renderSongList(e.target.value));

  // Save button
  $('save-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (song) {
      pushVersion();
      song.title = $('song-title').value || 'Untitled';
      song.updated_at = new Date().toISOString();
      saveSingleSong(song);
      toast('Saved ✓');
    }
  });

  // Audio recording
  $('record-btn').addEventListener('click', async () => {
    if (isRecording) { stopRecording(); return; }
    if (!getSong(currentSongId)) { toast('Open a song first'); return; }
    await startRecording();
  });

  // History button
  $('history-btn').addEventListener('click', toggleHistory);
  $('close-hist').addEventListener('click', () => $('history-panel').style.display = 'none');

  // Add section
  $('add-section-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return;
    pushVersion();
    song.sections.push({ type: 'Chorus', lines: [{ text: '', chords: [] }] });
    saveSingleSong(song);
    renderEditorBody(song);
    $('song-body').scrollTop = $('song-body').scrollHeight;
  });

  // Import button
  $('import-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('import-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    // Position above the button
    const rect = e.target.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.right = '16px';
  });

  // Import menu actions
  $('import-menu').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      $('import-menu').style.display = 'none';
      const action = btn.dataset.action;
      if (action === 'import-txt') {
        importFiles();
      } else if (action === 'import-pdf') {
        importPdf();
      }
    });
  });

  // More menu toggle
  $('toolbar-more-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('more-menu');
    if (menu.style.display === 'block') {
      menu.style.display = 'none';
    } else {
      // Close other menus
      $('export-menu').style.display = 'none';
      $('import-menu').style.display = 'none';
      menu.style.display = 'block';
    }
  });

  // More menu actions
  $('more-menu').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      $('more-menu').style.display = 'none';
      const action = btn.dataset.action;
      const song = getSong(currentSongId);
      if (!song && action !== 'import' && action !== 'export') return;

      if (action === 'transpose-up') {
        pushVersion();
        transposeSong(song, 1);
        await saveSingleSong(song);
        renderEditorBody(song);
        toast('+1 semitone');
      } else if (action === 'transpose-down') {
        pushVersion();
        transposeSong(song, -1);
        await saveSingleSong(song);
        renderEditorBody(song);
        toast('-1 semitone');
      } else if (action === 'set-key') {
        const key = prompt('Key (e.g. G, Am, F#m):', song.key || '');
        if (key !== null) {
          song.key = key.trim();
          updateMoreMenuKey(song);
          await saveSingleSong(song);
          renderSongList();
        }
      } else if (action === 'import') {
        const importMenu = $('import-menu');
        importMenu.style.display = 'block';
      } else if (action === 'export') {
        const exportMenu = $('export-menu');
        exportMenu.style.position = 'fixed';
        exportMenu.style.bottom = '70px';
        exportMenu.style.right = '16px';
        exportMenu.style.display = 'block';
      } else if (action === 'delete') {
        if (confirm(`Delete "${song.title}"?`)) {
          await deleteSong(currentSongId);
          currentSongId = null;
          popView();
          renderSongList();
          toast('Deleted');
        }
      }
    });
  });

  // Export menu actions
  $('export-menu').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      $('export-menu').style.display = 'none';
      const action = btn.dataset.action;
      const song = getSong(currentSongId);
      if (!song) return;

      if (action === 'export-txt') {
        downloadFile(buildExportText(song), `${song.title || 'song'}.txt`, 'text/plain');
        toast('Exported TXT');
      } else if (action === 'export-md') {
        downloadFile(buildExportMarkdown(song), `${song.title || 'song'}.md`, 'text/markdown');
        toast('Exported MD');
      } else if (action === 'export-clipboard') {
        navigator.clipboard.writeText(buildExportText(song)).then(() => toast('Copied!'));
      }
    });
  });

  // Close menus on background tap
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover') && !e.target.closest('#toolbar-more-btn') && !e.target.closest('#import-btn')) {
      document.querySelectorAll('.popover').forEach(m => m.style.display = 'none');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      undoVersion();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      const song = getSong(currentSongId);
      if (song) {
        pushVersion();
        song.title = $('song-title').value || 'Untitled';
        song.updated_at = new Date().toISOString();
        saveSingleSong(song);
        toast('Saved ✓');
      }
    }
  });

  // Setup folder actions
  setupFolderActions();
}

// ===== PDF Import =====
async function importPdf() {
  if (!isTauri) {
    toast('PDF import requires the app build', 'error');
    return;
  }
  // For Tauri, we'd use the dialog plugin — but since we're in browser mode for now
  toast('PDF import coming to mobile build', 'info');
}

// ===== Init =====
async function init() {
  await initTauri();
  await loadSongs();

  // Load folders
  try {
    const saved = JSON.parse(localStorage.getItem('folders_app'));
    if (saved && saved.length) folders = saved;
  } catch {}
  if (isTauri) {
    const backendFolders = await tauriLoadFolders();
    if (backendFolders && backendFolders.length) folders = backendFolders;
  }

  addSampleSongs();
  renderFolders();
  setupEvents();

  console.log(`Song Notes initialized: ${songs.length} songs, ${folders.length} folders`);
}

init();
