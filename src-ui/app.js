// ===== Song Notes Mobile — Apple Notes style =====

import { invoke } from '@tauri-apps/api/core';

let isTauri = false;
let songs = [];
let folders = ['All Songs'];
let currentFolder = 'All Songs';
let currentSongId = null;
let viewStack = ['folder-view'];
let autoSaveTimer = null;

// ===== Chord Definitions =====
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROMATIC_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_ALIASES = {
  'C#': 'Db', 'Db': 'C#', 'D#': 'Eb', 'Eb': 'D#',
  'F#': 'Gb', 'Gb': 'F#', 'G#': 'Ab', 'Ab': 'G#',
  'A#': 'Bb', 'Bb': 'A#'
};

function noteToSemitone(note) {
  const n = note.toUpperCase();
  const idx = CHROMATIC.indexOf(n);
  if (idx !== -1) return idx;
  const idxFlat = CHROMATIC_FLAT.indexOf(n);
  return idxFlat;
}

function semitoneToNote(s, useFlats) {
  const scale = useFlats ? CHROMATIC_FLAT : CHROMATIC;
  return scale[((s % 12) + 12) % 12];
}

// Transpose a chord name (e.g. "Am" -> "Bm", "G7" -> "Ab7", "F#m7" -> "Gm7")
function transposeChord(chordName, semitones) {
  if (!chordName || !chordName.trim()) return chordName;
  const m = chordName.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return chordName;
  const root = m[0]; // full match
  const note = m[1];
  const suffix = m[2];
  const idx = noteToSemitone(note);
  if (idx === -1) return chordName;
  const newNote = semitoneToNote(idx + semitones);
  // Preserve accidental style (sharp vs flat)
  return newNote + suffix;
}

// Transpose all chords in a song
function transposeSong(song, semitones) {
  song.sections.forEach(section => {
    section.lines.forEach(line => {
      line.chords.forEach(ch => {
        ch.name = transposeChord(ch.name, semitones);
      });
    });
  });
  // Also transpose the key
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
    console.log('Tauri backend connected');
  } catch (e) {
    isTauri = false;
    console.log('Running in browser mode (no Tauri)');
  }
}

// ===== Tauri Backend Persistence =====
async function tauriLoadSongs() {
  try {
    const result = await invoke('load_songs');
    return result || [];
  } catch (e) {
    console.error('Tauri load_songs failed:', e);
    return null;
  }
}

async function tauriSaveSong(song) {
  try {
    await invoke('save_song', { song });
    return true;
  } catch (e) {
    console.error('Tauri save_song failed:', e);
    return false;
  }
}

async function tauriDeleteSong(id) {
  try {
    await invoke('delete_song', { id });
    return true;
  } catch (e) {
    console.error('Tauri delete_song failed:', e);
    return false;
  }
}

async function tauriLoadFolders() {
  try {
    const result = await invoke('load_folders');
    return result;
  } catch (e) {
    console.error('Tauri load_folders failed:', e);
    return null;
  }
}

async function tauriSaveFolders(folderList) {
  try {
    await invoke('save_folders', { folders: folderList });
    return true;
  } catch (e) {
    console.error('Tauri save_folders failed:', e);
    return false;
  }
}

// ===== Persistence (Tauri-first, localStorage fallback) =====
async function loadSongs() {
  if (isTauri) {
    const result = await tauriLoadSongs();
    if (result) {
      songs = result;
      return;
    }
  }
  // Fallback to localStorage
  try {
    songs = JSON.parse(localStorage.getItem('songs_app')) || [];
  } catch { songs = []; }
}

async function saveSongs() {
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) {
    for (const song of songs) {
      await tauriSaveSong(song);
    }
  }
}

async function saveSingleSong(song) {
  // Update in-memory array
  const idx = songs.findIndex(s => s.id === song.id);
  if (idx >= 0) songs[idx] = song;
  else songs.unshift(song);
  // Persist
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) {
    await tauriSaveSong(song);
  }
}

// ===== Song CRUD =====
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createSong(title = 'Untitled') {
  return {
    id: generateId(),
    title: title,
    key: '',
    bpm: null,
    time_sig: null,
    tags: [],
    folder: null,
    sections: [{
      type: 'Verse 1',
      lines: [{ text: '', chords: [] }]
    }],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function getSong(id) { return songs.find(s => s.id === id); }

async function deleteSong(id) {
  songs = songs.filter(s => s.id !== id);
  localStorage.setItem('songs_app', JSON.stringify(songs));
  if (isTauri) {
    await tauriDeleteSong(id);
  }
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

// ===== Auto-Save with Debounce =====
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
  el.innerHTML = folders.map(f => `
    <div class="list-item" data-folder="${escapeHtml(f)}">
      <span class="item-icon">📁</span>
      <span class="item-title">${escapeHtml(f)}</span>
      <span class="item-meta">${f === 'All Songs' ? songs.length : songs.filter(s => s.folder === f).length}</span>
      <span class="item-chevron">›</span>
    </div>
  `).join('');

  el.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => {
      currentFolder = item.dataset.folder;
      $('folder-title').textContent = currentFolder;
      renderSongList();
      pushView('song-list-view');
    });
  });
}

// ===== Render Song List =====
function renderSongList(filter = '') {
  const el = $('song-list');
  let list = currentFolder === 'All Songs'
    ? songs
    : songs.filter(s => s.folder === currentFolder);

  if (filter) {
    const q = filter.toLowerCase();
    list = list.filter(s => s.title.toLowerCase().includes(q));
  }

  if (list.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🎵</div><h2>No songs yet</h2><p>Tap + to create your first song</p></div>';
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
  renderEditorBody(song);
  updateMoreMenuKey(song);
}

function updateMoreMenuKey(song) {
  const keyBtn = $('more-menu')?.querySelector('[data-action="set-key"]');
  if (keyBtn) {
    keyBtn.textContent = song.key ? `Key: ${song.key}` : 'Key: None';
  }
}

function renderEditorBody(song) {
  const el = $('song-body');
  el.innerHTML = '';
  song.sections.forEach((section, si) => {
    const tmpl = $('section-template').content.cloneNode(true);
    const sectionEl = tmpl.querySelector('.song-section');
    const typeSelect = tmpl.querySelector('.section-type');

    // Set section type
    const opt = typeSelect.querySelector(`option[value="${escapeHtml(section.type)}"]`);
    if (opt) opt.selected = true;

    // Delete section
    tmpl.querySelector('.delete-section').addEventListener('click', () => {
      song.sections.splice(si, 1);
      saveSingleSong(song);
      renderEditorBody(song);
    });

    // Type change
    typeSelect.addEventListener('change', () => {
      song.sections[si].type = typeSelect.value;
      triggerAutoSave(song);
    });

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
      editorDiv.scrollTop = editorDiv.scrollHeight;
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

  // Render chord placeholders above the lyric text
  function renderChords() {
    lineEl.querySelectorAll('.chord-placeholder').forEach(e => e.remove());
    line.chords.forEach(ch => {
      const span = document.createElement('span');
      span.className = 'chord-placeholder';
      span.textContent = ch.name;
      span.style.left = ch.x + 'px';
      span.dataset.chordIndex = line.chords.indexOf(ch);
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        showChordEdit(song, line, ch, textArea);
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
      showChordEdit(song, line, chord, textArea);
    }
  });

  lineEl.appendChild(textArea);
  // Insert before the add-line button (last child)
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

function showChordEdit(song, line, chord, textArea) {
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

  // Close on tap outside
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
    const maxChordLen = section.lines.reduce((max, l) => {
      const chordStr = l.chords.map(c => c.name.padEnd(4)).join(' ');
      return Math.max(max, chordStr.length);
    }, 0);

    section.lines.forEach(line => {
      if (line.chords.length > 0) {
        // Build chord line above lyrics
        let chordLine = '';
        let lastX = 0;
        line.chords.forEach(ch => {
          const spaces = Math.max(0, ch.x - lastX);
          chordLine += ' '.repeat(spaces) + ch.name;
          lastX = ch.x + ch.name.length * 8; // rough pixel-to-char approximation
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
  if (song.bpm) md += `- **BPM:** ${song.bpm}\n`;
  md += '\n';

  song.sections.forEach(section => {
    md += `## ${section.type}\n\n`;
    section.lines.forEach(line => {
      const lineText = line.text;
      const chordStr = line.chords
        .sort((a, b) => a.x - b.x)
        .map(c => c.name)
        .join(' ');
      if (chordStr) {
        md += `  ${chordStr}  \n`;
      }
      md += `${lineText}\n\n`;
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
  if (songs.length > 0) return; // Only add if no songs exist

  const samples = [
    {
      title: 'Blinding Lights',
      key: 'F#m',
      bpm: 171,
      sections: [
        {
          type: 'Intro',
          lines: [
            { text: 'Yeah, yeah', chords: [{x: 10, name: 'F#m'}] },
            { text: '', chords: [] }
          ]
        },
        {
          type: 'Verse 1',
          lines: [
            { text: "I've been tryna call", chords: [{x: 10, name: 'F#m'}] },
            { text: "I've been on my own for long enough", chords: [{x: 60, name: 'D'}] },
            { text: "Maybe you can show me how to love", chords: [{x: 120, name: 'A'}] },
            { text: "Maybe I'm going through withdrawals", chords: [{x: 180, name: 'E'}] }
          ]
        },
        {
          type: 'Chorus',
          lines: [
            { text: 'I said, ooh, I\'m blinded by the lights', chords: [{x: 10, name: 'F#m'}, {x: 180, name: 'D'}] },
            { text: "No, I can't sleep until I feel your touch", chords: [{x: 60, name: 'A'}, {x: 180, name: 'E'}] }
          ]
        }
      ]
    },
    {
      title: 'Hallelujah',
      key: 'C',
      sections: [
        {
          type: 'Verse 1',
          lines: [
            { text: "I've heard there was a secret chord", chords: [{x: 10, name: 'C'}, {x: 180, name: 'Am'}] },
            { text: 'That David played and it pleased the Lord', chords: [{x: 10, name: 'C'}, {x: 180, name: 'Am'}] },
            { text: "But you don't really care for music, do ya?", chords: [{x: 10, name: 'F'}, {x: 100, name: 'G'}, {x: 200, name: 'C'}, {x: 280, name: 'G'}] },
            { text: "It goes like this: the fourth, the fifth", chords: [{x: 10, name: 'C'}, {x: 120, name: 'F'}, {x: 200, name: 'G'}] },
            { text: 'The minor fall, the major lift', chords: [{x: 10, name: 'Am'}, {x: 150, name: 'F'}] },
            { text: 'The baffled king composing Hallelujah', chords: [{x: 10, name: 'G'}, {x: 130, name: 'E7'}, {x: 230, name: 'Am'}] }
          ]
        },
        {
          type: 'Chorus',
          lines: [
            { text: 'Hallelujah, Hallelujah', chords: [{x: 10, name: 'F'}] },
            { text: 'Hallelujah, Hallelu-u-u-jah', chords: [{x: 10, name: 'Am'}, {x: 180, name: 'F'}, {x: 250, name: 'C'}, {x: 320, name: 'G'}] }
          ]
        }
      ]
    },
    {
      title: 'New Song Idea',
      key: 'G',
      bpm: 120,
      sections: [
        {
          type: 'Verse 1',
          lines: [
            { text: 'Write your lyrics here', chords: [{x: 10, name: 'G'}] },
            { text: 'Tap to add chords', chords: [{x: 60, name: 'C'}] },
            { text: 'Keep writing...', chords: [{x: 120, name: 'D'}] }
          ]
        },
        {
          type: 'Chorus',
          lines: [
            { text: 'This is the chorus', chords: [{x: 10, name: 'G'}, {x: 120, name: 'Em'}] },
            { text: 'Catchy and repeatable', chords: [{x: 10, name: 'C'}, {x: 150, name: 'D'}] }
          ]
        }
      ]
    }
  ];

  samples.forEach(data => {
    const song = createSong(data.title);
    song.key = data.key || '';
    song.bpm = data.bpm || null;
    song.sections = data.sections.map(s => ({
      type: s.type,
      lines: s.lines.map(l => ({
        text: l.text,
        chords: l.chords.map(c => ({ x: c.x, name: c.name }))
      }))
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
      localStorage.setItem('folders_app', JSON.stringify(folders));
      if (isTauri) tauriSaveFolders(folders);
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
  $('search-input').addEventListener('input', (e) => {
    renderSongList(e.target.value);
  });

  // Save button
  $('save-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (song) {
      song.title = $('song-title').value || 'Untitled';
      song.updated_at = new Date().toISOString();
      saveSingleSong(song);
      toast('Saved ✓');
    }
  });

  // Add section
  $('add-section-btn').addEventListener('click', () => {
    const song = getSong(currentSongId);
    if (!song) return;
    song.sections.push({
      type: 'Chorus',
      lines: [{ text: '', chords: [] }]
    });
    saveSingleSong(song);
    renderEditorBody(song);
    $('song-body').scrollTop = $('song-body').scrollHeight;
  });

  // Chords help button
  $('chords-btn').addEventListener('click', () => {
    toast('Tap on a line to add a chord');
  });

  // More menu toggle
  $('toolbar-more-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('more-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  // More menu actions
  $('more-menu').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      $('more-menu').style.display = 'none';
      const action = btn.dataset.action;
      const song = getSong(currentSongId);
      if (!song) return;

      if (action === 'transpose-up') {
        transposeSong(song, 1);
        await saveSingleSong(song);
        renderEditorBody(song);
        toast('Transposed +1 semitone');
      } else if (action === 'transpose-down') {
        transposeSong(song, -1);
        await saveSingleSong(song);
        renderEditorBody(song);
        toast('Transposed -1 semitone');
      } else if (action === 'set-key') {
        const key = prompt('Key (e.g. G, Am, F#m):', song.key || '');
        if (key !== null) {
          song.key = key.trim();
          btn.textContent = song.key ? `Key: ${song.key}` : 'Key: None';
          await saveSingleSong(song);
          renderSongList();
        }
      } else if (action === 'export') {
        showExportMenu();
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

  // Close menus on background tap
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover') && !e.target.closest('#toolbar-more-btn')) {
      const menu = $('more-menu');
      if (menu) menu.style.display = 'none';
    }
  });
}

// ===== Export Menu =====
function showExportMenu() {
  const song = getSong(currentSongId);
  if (!song) return;

  const format = confirm('Export as Markdown?\n\nCancel = plain text');
  const content = format ? buildExportMarkdown(song) : buildExportText(song);
  const ext = format ? 'md' : 'txt';
  downloadFile(content, `${song.title || 'song'}.${ext}`, format ? 'text/markdown' : 'text/plain');
  toast(`Exported as ${ext.toUpperCase()}`);
}

// ===== Init =====
async function init() {
  await initTauri();

  // Load songs
  await loadSongs();

  // Load folders from localStorage
  try {
    const saved = JSON.parse(localStorage.getItem('folders_app'));
    if (saved && saved.length) folders = saved;
  } catch {}

  // If Tauri, try loading folders from backend too
  if (isTauri) {
    const backendFolders = await tauriLoadFolders();
    if (backendFolders && backendFolders.length) {
      folders = backendFolders;
    }
  }

  // Add sample songs if none exist
  addSampleSongs();

  renderFolders();
  setupEvents();

  console.log(`Song Notes initialized with ${songs.length} songs, ${folders.length} folders`);
}

init();
