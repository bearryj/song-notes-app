# Song Notes App — AGENTS.md

## Project Overview
Mobile songwriting app — Apple Notes inspired, built for musicians.
Built with Tauri 2.x + Vite + vanilla JS. Targets Android (test) and iOS (ship).

**Project path:** `C:\Users\Justin\song-notes-app`
**Repo:** `https://github.com/bearryj/song-notes-app`

## Architecture

### Frontend (`/src-ui/`)
- **index.html** — Mobile-first layout: folder list → song list → editor with toolbar, import/export menus, history panel
- **app.js** — All frontend logic: navigation, song CRUD, chord editing, audio recording, version history, import/export, transposition
- **styles.css** — Apple Notes-inspired dark theme, mobile-first responsive

### Backend (`/src-tauri/`)
- **src/lib.rs** — Rust Tauri commands: song CRUD, folder management, file read for import
- **src/main.rs** — Entry point
- **Cargo.toml** — Dependencies: tauri 2.11.2, serde, serde_json

### Build System
- **package.json** — Vite dev server on port 1422
- **vite.config.js** — Root: src-ui, outDir: ../dist
- **tauri.conf.json** — beforeDevCommand: `npm run dev`, mobile-only
- **Android** — `npx tauri android init` already run (NDK 27.1)

## Features Implemented
- [x] Mobile-first navigation (folders → songs → editor with slide transitions)
- [x] Song CRUD with Tauri backend + localStorage fallback
- [x] Inline chord editing (pixel-positioned, tap to add/remove/edit)
- [x] Apple Notes-inspired dark theme
- [x] Auto-save with 800ms debounce
- [x] Chord transposition (+1/-1 semitone, all chords + key)
- [x] Audio recording (webm/base64 per song, play recordings)
- [x] Version history (undo up to 20 snapshots, Ctrl+Z)
- [x] Export (txt, markdown, clipboard copy)
- [x] Import (txt/md files, parses chord brackets and section headers)
- [x] Section management (add, delete, duplicate, reorder via ↑↓ drag)
- [x] Folder management (create, rename, delete custom folders)
- [x] Song search/filter
- [x] Sample songs on first launch (3 songs)
- [x] Android APK builds (arm64-v8a, arm, x86, x86_64, universal)
- [x] Rust backend compiles clean
- [x] Touch-friendly chord editor (drag to move, long-press to delete, double-tap to add)
- [x] Mobile bottom sheet chord popup with large touch targets
- [x] Collapsible mobile toolbar with auto-hide on scroll
- [x] Floating action button (FAB) for quick toolbar access
- [x] Toolbar bottom sheet with 8 tools in grid layout

## Android Build Note
Windows Developer Mode required for symlinks. Workaround: patch BuildTask.kt to skip Rust build if .so exists; copy .so to jniLibs/ then run `gradlew assembleDebug`.

## Data Model
```json
{
  "id": "song_id",
  "title": "Song Name", "key": "G", "bpm": 120,
  "time_sig": null, "tags": [], "folder": null,
  "sections": [{
    "type": "Chorus",
    "lines": [{ "text": "lyrics", "chords": [{"x": 50, "name": "G"}] }]
  }],
  "audio": [{ "data": "data:audio/webm;base64,...", "ts": 1234567890 }],
  "created_at": "ISO8601", "updated_at": "ISO8601"
}
```
