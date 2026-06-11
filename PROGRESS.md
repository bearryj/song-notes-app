# Song Notes App — Progress Tracker

## Last Updated
2026-06-11 by OWL (share song — share codes, native share, clipboard, import)

## Build & Test Commands
```bash
export PATH="/c/Users/Justin/.cargo/bin:$PATH"
# Rust compile check
cd /c/Users/Justin/song-notes-app/src-tauri && cargo check
# Frontend dev server (port 1422)
cd /c/Users/Justin/song-notes-app && npm run dev
# Android APK build
cd /c/Users/Justin/song-notes-app/src-tauri && cargo tauri android build --apk
```
```bash
cd /c/Users/Justin/song-notes-app
git status && git log --oneline -3
git push origin main
```

## Kill Port 1422 Zombie
```powershell
powershell.exe -Command "Get-NetTCPConnection -LocalPort 1422 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"
```

## Features Shipped
- Mobile-first navigation (folders → songs → editor with slide transitions)
- Song CRUD with Tauri backend + localStorage fallback
- Inline chord editing (pixel-positioned, tap to add/remove/edit)
- Apple Notes-inspired dark theme
- Auto-save with 800ms debounce
- Chord transposition (+1/-1 semitone, all chords + key)
- Audio recording (webm/base64 per song, play recordings)
- Version history (undo up to 20 snapshots, Ctrl+Z)
- Export (txt, markdown, clipboard copy)
- Import (txt/md files, parses chord brackets and section headers)
- Section management (add, delete, duplicate, reorder via ↑↓ drag)
- Folder management (create, rename, delete custom folders)
- Song search/filter
- Sample songs on first launch (3 songs)
- Android APK builds (arm64-v8a, arm, x86, x86_64, universal)
- Rust backend compiles clean
- Touch-friendly chord editor (drag to move, long-press to delete, double-tap to add)
- Mobile bottom sheet chord popup with large touch targets
- Collapsible mobile toolbar with auto-hide on scroll
- Floating action button (FAB) for quick toolbar access
- Toolbar bottom sheet with 8 tools in grid layout
- Apple Notes-level UX: theme, info panel, gallery view, smart folders, save indicator
- Song templates: Blank, Verse-Chorus, AABA, Verse Only
- Desktop-grade chord row + quick-select popup on mobile
- Mobile keyboard handling (avoid viewport resize issues)
- Setlist mode (create/rename/delete setlists, add/remove/reorder songs, capo per song, transpose all, chord chart print)
- Share song (generate share codes, native share API, clipboard, import from share code)

## TODOs (priority order)
1. [x] Touch-friendly chord editor — drag, long-press, double-tap (2026-06-11)
2. [x] Mobile toolbar with bottom sheet (2026-06-11)
3. [x] Mobile keyboard handling (2026-06-11)
4. [x] Setlist mode (order songs, capo per song, chord chart print) (2026-06-11)
5. [x] Chord diagram panel (common chord shapes, finger positions) (2026-06-11)
6. [x] Collaborative editing (share link, real-time sync) (2026-06-11)
7. [ ] Plugin system for custom export formats
8. [ ] iOS build (requires macOS + Xcode)

## Architecture Quick Ref
- **Frontend:** Vanilla JS (src-ui/app.js ~60K), CSS (styles.css ~19K), HTML (index.html)
- **Backend:** Rust/Tauri (src-tauri/src/lib.rs) — song CRUD, folder management, file read for import
- **Data:** JSON files via Tauri file I/O, localStorage fallback for web preview
- **Chord position:** `{x: <pixel>, name: "G"}` — pixel-based x offset
- **Section format:** `{type: "Verse 1", lines: [{text: "...", chords: [...]}]}`
- **Dev server:** Vite on port 1422 (desktop dev), Tauri mobile for Android/iOS
- **Android:** `npx tauri android init` already run (NDK 27.1)

## Blockers
- iOS builds require macOS + Xcode — not available on this Windows dev machine
- Android symlink issues on Windows — workaround: patch BuildTask.kt, copy .so to jniLibs/

## Android Build Note
Windows Developer Mode required for symlinks. Workaround: patch BuildTask.kt to skip Rust build if .so exists; copy .so to jniLibs/ then run `gradlew assembleDebug`.
