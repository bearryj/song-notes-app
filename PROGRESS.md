# Song Notes App — Progress Tracker

## Last Updated
2026-06-12 by OWL (UI overhaul: emoji→glyphs, nav cleanup, grouped toolbar, setlist nav button)

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

## TODOs (priority order)
1. [x] Touch-friendly chord editor — drag, long-press, double-tap (2026-06-11)
2. [x] Mobile toolbar with bottom sheet (2026-06-11)
3. [x] Mobile keyboard handling (2026-06-11)
4. [x] Setlist mode (order songs, capo per song, chord chart print) (2026-06-11)
5. [x] Chord diagram panel (common chord shapes, finger positions) (2026-06-11)
6. [x] Collaborative editing (share link, real-time sync) (2026-06-11)
7. [x] Plugin system for custom export formats (2026-06-11)
8. [ ] iOS build (requires macOS + Xcode)
9. [x] Metronome (BPM-based click track) (2026-06-11)
10. [x] Song statistics (chord frequency, word count trends, key detection) (2026-06-11)
11. [x] Debounce search input (2026-06-11)
12. [x] Tag management UI (add/edit/display/filter tags — data model supports it, search already indexes it, but no editor UI) (2026-06-11)
13. [x] Replace remaining raw prompt()/confirm() dialogs with proper UI (folder rename/delete, setlist create/rename, set key, set BPM, import) (2026-06-11)
14. [x] Visual key picker in toolbar (2026-06-11) — replaced by dedicated transposition key picker (item 62)
15. [x] Haptic feedback on key/metronome taps (2026-06-11) — metroVibrate() with accent beat pattern
16. [x] Duplicate song from toolbar sheet (2026-06-11) — deep copy with new id, title suffix, pinned reset
17. [x] Undo for section and line deletion (2026-06-11) — undoBuffer with snackbar toast, 4s dismiss timer, restores exact position
18. [x] Pull-to-refresh on song list (2026-06-11) — touch gesture to reload data from storage, animated indicator
19. [x] Accessibility: ARIA roles/labels + :focus-visible keyboard nav (2026-06-11) — role/aria-label on all interactive elements, focus ring styles, radiogroup/radio roles, aria-live regions
20. [x] UI overhaul — emoji→text glyphs, editor nav cleanup, grouped toolbar sections, setlist nav button, info bar readability (2026-06-12)
21. [x] Quick song switcher in editor (prev/next or swipe between songs in current folder) (2026-06-12) — compact ‹‹ ›› buttons in editor nav bar, wraps around, slide transition, auto-saves current song, mirrors sort order
22. [ ] Chord ribbon — make collapsible

## Newly Discovered TODOs
- [x] Add loading spinner/skeleton screens for song list (2026-06-11) — shimmer skeleton with staggered animation on init + refresh
- [x] Song list sort options (recent, A-Z, Z-A, key) (2026-06-11) — sort button in nav bar, popover with 4 modes, pinned always first, persisted to localStorage
- [x] Support drag files into app for import (desktop) (2026-06-11) — drag-and-drop overlay on #app container, filters .txt/.md, reuses importFiles(), bounce animation
- [x] Chord progression ribbon in editor (2026-06-11) — horizontal strip showing unique chords per section, tap to highlight + scroll to first occurrence in body
- [x] Swipe-to-action on song list items (2026-06-11) — swipe left to reveal pin (★) and delete (✕) action buttons, snap-open/close with smooth animation, tap-outside-to-close
- [x] Auto-save song title on input (2026-06-11) — title input triggers auto-save with 1200ms debounce, syncs title into song object before save
- [x] Song writing session timer (2026-06-11) — elapsed editing time shown in editor nav, persists session_ms to song data, accumulates across sessions
- [x] Error recovery UI — init error state with retry button + global unhandledrejection/error handlers (2026-06-12) — try/catch around init(), shows error-state with Try Again button, window listeners for uncaught errors surface toast notifications


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
