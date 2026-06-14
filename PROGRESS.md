# Song Notes App — Progress Tracker

## Last Updated
2026-06-14 by OWL (show writing time in song list rows)

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
- Toolbar bottom sheet with grouped sections (Song, Export, Tools, Organize, View)
- Apple Notes-level UX: theme, info panel, gallery view, smart folders, save indicator
- Song templates: Blank, Verse-Chorus, AABA, Verse Only
- Desktop-grade chord row + quick-select popup on mobile
- Mobile keyboard handling (avoid viewport resize issues)
- Setlist mode (create/rename/delete setlists, add/remove/reorder songs, capo per song, transpose all, chord chart print)
- Share song (generate share codes, native share API, clipboard, import from share code)
- Plugin system for custom export formats (template engine, 5 built-in plugins, editor UI)
- Version diff view (LCS-based line diff between any two versions, restore from diff)
- Metronome (BPM-based click track with visual beat indicator, time signatures, tempo presets)
- Song statistics (chord frequency, word count, key detection with Krumhansl-Schmuckler, section breakdown, chord progression)
- Tag management (add/edit/remove tags, filter songs by tag, display tags in song list)
- New song creation sheet (title input + visual template picker, replacing raw prompt() dialogs)
61|- Polished bottom sheets replacing all raw browser prompt()/confirm() dialogs (input sheet + confirm sheet)
62|- Visual key picker for transposition (circle-of-fifths grid, 12 keys, quick ♭/♯ buttons)
- Duplicate song (deep copy from toolbar sheet, auto-suffixes title with " (Copy)")
- Song list sort (4 modes: recent, A→Z, Z→A, Key — pinned always first, persisted)
- Swipe-to-action on song list (swipe left to reveal pin ★ and delete ✕ buttons, snap animation, tap-outside-to-close)
- Song writing session timer (tracks editing time per song, persists across sessions, displays in editor nav bar)
- Directional view transitions (forward nav slides right→left, back nav slides left→right with nav bar parallax)
- Move song to folder (from song context menu, folder picker sheet with current folder checkmark, drag-to-dismiss)
|- Unsaved changes protection (beforeunload warning when edits pending, visibilitychange auto-save on mobile background/tab switch)
|- Focus Mode (distraction-free editor toggle, hides toolbar/ribbon/FAB, blurred nav bar, vignette edges, persists to localStorage)
- Keyboard shortcuts help overlay (Ctrl+/ or ? to show grouped shortcuts in Apple Notes-style modal)
- Pagehide save handler (reliable save on mobile app kill/swipe-away where beforeunload doesn't fire, extracted emergencySave())
- Song Info panel: capo + writing time stats (shows capo setting and accumulated session time with live update when song is open)
- Writing time in song list (compact "Xh Xm" or "Xm" badge on each row in both list and gallery views, using existing session_ms data)
- Auto-save timer flush on song switch + back navigation (prevents stale debounced writes from corrupting state when quick-switching songs or going back)
- Swipe gesture to switch songs in editor (swipe left → next, swipe right → prev, with haptic feedback)
- Song content preview in list view (chord chips + first lyric line snippet under each title)
|- Tap tempo (tap-to-detect BPM with outlier filtering, auto-applies to metronome, 2s auto-reset)
- Duplicate song from swipe action (⧉ button in swipe-to-action bar, deep copy with new id and title suffix)
- Enhanced empty states (SVG illustrations, floating animation, fade-in, CTA button for new users)
- Individual song print chord chart (print preview overlay with chord/lyric layout, window.print() integration, @media print styles)
- [x] Duplicate line in editor (⧉ button in chord row, deep copy with chords, undo support via snackbar)
- [x] Chord sheet display modes (toggle between chords+lyrics, lyrics-only, chords-only; nav bar button + toolbar View section; persisted to localStorage)
- [x] Strumming pattern notation (per-section text pattern editor, e.g. "D-DU-UDU"; toggle button in section header; included in export, print, and share codes)
- [x] Chromatic tuner (autocorrelation pitch detection from mic, guitar string selector E2-A2-D3-G3-B3-E4, cents needle meter, sharp/flat/in-tune display)
- [x] Trash bulk actions (Restore All + Empty Trash buttons in Recently Deleted view with confirmation sheets)
- [x] Transpose toast shows old → new key (e.g., "G → F♯")

## TODOs — Refinement & Bug Fixes

### UI Polish
- [x] Song list play/pause button styling — pill button with proper touch targets (26px min-height, 38px min-width), subtle border, accent playing state with opacity pulse animation on the icon (2026-06-13)
- [x] Graceful degradation for large songs — songs with 50+ sections can cause jank when rendering the editor. Add lazy rendering for off-screen sections. (2026-06-13 — fixed: `initSectionObserver` was defined but never called; wiring it up plus lowered threshold to 30 sections)

### Bugs / Reliability
- (none currently known — all previous bugs resolved)

### Code Hygiene
- [x] Remove debug console.log statements — 13 debug logs removed from recording/playback code (mediaRecorder, test player, playRecording, toggleRecordingsDropdown, sync queue). Kept error handlers that also show toast notifications. (2026-06-13)

### Platform
- [ ] iOS build (requires macOS + Xcode) — blocked on hardware
- [ ] Android: test on a real device — touch gestures, audio recording, localStorage limits
- [ ] Android: build and test APK on real device — the symlink workaround may not hold on all devices
- [x] Keyboard shortcuts for desktop — Ctrl+S (save), Ctrl+Z (undo), Ctrl+F (find), Ctrl+P (print), arrow keys for song navigation. (2026-06-13)
- [x] Desktop Tauri build — the app is mobile-only in tauri.conf.json; enable desktop targets for Windows/Mac/Linux distribution (2026-06-13 — added window config: 1000×700 default, 380×500 min, resizable, with title "Song Notes")

## Architecture Quick Ref
- **Frontend:** Vanilla JS (src-ui/app.js ~170K), CSS (styles.css ~72K), HTML (index.html)
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
