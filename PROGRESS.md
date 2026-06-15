# Song Notes App — Progress Tracker

## Last Updated
2026-06-15 by OWL (feat: add ARIA roles to dynamically rendered list items for accessibility)

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
- Polished bottom sheets replacing all raw browser prompt()/confirm() dialogs (input sheet + confirm sheet)
- Visual key picker for transposition (circle-of-fifths grid, 12 keys, quick ♭/♯ buttons)
- Duplicate song (deep copy from toolbar sheet, auto-suffixes title with " (Copy)")
- Song list sort (5 modes: recent, A→Z, Z→A, Key, BPM — pinned always first, persisted)
- Swipe-to-action on song list (swipe left to reveal pin ★ and delete ✕ buttons, snap animation, tap-outside-to-close)
- Song writing session timer (tracks editing time per song, persists across sessions, displays in editor nav bar)
- Directional view transitions (forward nav slides right→left, back nav slides left→right with nav bar parallax)
- Edge-swipe-to-go-back gesture (swipe right from left edge to navigate back, 40px threshold, 60px min travel, vertical scroll cancellation, haptic feedback) (2026-06-14)
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
- Tap tempo (tap-to-detect BPM with outlier filtering, auto-applies to metronome, 2s auto-reset)
- Duplicate song from swipe action (⧉ button in swipe-to-action bar, deep copy with new id and title suffix)
- Enhanced empty states (SVG illustrations, floating animation, fade-in, CTA button for new users)
- Individual song print chord chart (print preview overlay with chord/lyric layout, window.print() integration, @media print styles)
- Trash bulk actions (Restore All + Empty Trash buttons in Recently Deleted view with confirmation sheets)
- Transpose toast shows old → new key (e.g., "G → F♯")
- Duplicate line in editor (⧉ button in chord row, deep copy with chords, undo support via snackbar)
- Chord sheet display modes (toggle between chords+lyrics, lyrics-only, chords-only; nav bar button + toolbar View section; persisted to localStorage)
- Strumming pattern notation (per-section text pattern editor, e.g. "D-DU-UDU"; toggle button in section header; included in export, print, and share codes)
- Chromatic tuner (autocorrelation pitch detection from mic, guitar string selector E2-A2-D3-G3-B3-E4, cents needle meter, sharp/flat/in-tune display)
- Typewriter scroll centering (keeps active lyric line centered while typing, debounced smooth scroll, toggle in toolbar View section, persisted to localStorage)
- Clipboard error handling — all `navigator.clipboard.writeText()` calls now have `.catch()` handlers that show an error toast when clipboard access fails (e.g. in Tauri WebView or non-HTTPS contexts), instead of silently swallowing the error
|- Clear all chords from song (toolbar Tools section action, removes all chord markings with full undo support via undoBuffer, chord count shown in toast) (2026-06-15)
|- Haptic feedback centralized — haptic(ms) helper replaces all inline navigator.vibrate() calls; wired to toolbar sheet buttons, FAB, swipe-to-action (open + button taps), edge-swipe back, chord long-press delete, song long-press multi-select, editor swipe (2026-06-15)
|- Color-coded section type labels in editor (each section type — Verse, Chorus, Bridge, Pre-Chorus, Intro, Outro, Tag, Coda — gets a distinct accent color as left border + subtle tinted background on section header; section type text inherits accent color; CSS custom properties with light theme variants; data-section-type attribute updated dynamically on rename) (2026-06-15)
- [x] Comprehensive prefers-reduced-motion CSS
- [x] Session timer pause/resume (timer pauses when app backgrounds/tabs away and resumes on return, so background time doesn't count as writing time)
- [x] Search/filter in setlist song picker (live search by title, key, or tag when adding songs to a setlist; auto-focuses input; shows "No matching songs" empty state) (2026-06-14)
- [x] Feature discovery hint system CSS — showFeatureHint() was called from 3 places (gallery toggle, multi-select bar, swipe actions) but had zero CSS styles, rendering hints invisible. Added complete styles: positioned tooltip bubble with ::before arrows for all 4 directions, dismiss button, entrance animation, tap-outside-to-dismiss, auto-dismiss after 4s, and prefers-reduced-motion support. (2026-06-14)
- [x] Safe localStorage writes — added safeStorageSet() helper with try/catch and quota-exceeded detection (matches QuotaExceededError by name, code 22/1014, and message). Replaced all 20+ raw localStorage.setItem calls (only 3 were previously wrapped). Shows a single per-session toast ("Storage full — delete old recordings to free space") so users know when audio recordings have filled localStorage. (2026-06-14)
- [x] Accurate chord positioning on line split/merge — replaced hardcoded `focusOffset * 8` pixel estimation with proper text measurement using Range.getBoundingClientRect() (for split) and Canvas2D measureText() (for merge). Fixes chord misalignment when using using non-default font sizes or non-mono fonts. (2026-06-14)
- [x] ARIA roles on dynamic list items — added `role="option"` and `aria-selected` to gallery cards, virtual scroll song rows, and folder list items within their respective `role="listbox"` containers. Screen readers now correctly announce list size, position, and selection state. (2026-06-15)
- [x] Mini chord diagram in chord edit popup — added `renderMiniFretboard()` function that generates a compact 120×148px SVG fretboard diagram. The diagram appears in the chord edit bottom sheet between the input and quick-select buttons, updating in real-time as the user types or taps root/suffix buttons. Shows finger positions, open/muted strings, barre chords, fret numbers, and string labels. Hidden when the chord name doesn't match a known shape. Increased popup max-height from 70vh to 80vh to accommodate the diagram. (2026-06-14)
- [x] Swipe fretboard to cycle through song's unique chords — added `getSongUniqueChords()` helper that extracts unique chords in order of first appearance from the current song. Swipe left/right on the fretboard area cycles through only the song's chords (not the full dictionary). Prev/next buttons also use the song chord list when ≥2 chords exist. Shows a "3 / 7" counter below the chord name. Includes a "‹ swipe ›" hint on touch devices (`@media (pointer: coarse)`), `touch-action: pan-y` to allow vertical scroll, grab cursor, and a translateX bounce animation on swipe. Counter updates on every chord change including manual input. (2026-06-14)
- [x] Chord progression suggestions in edit popup — added `getChordSuggestions()` function that uses music theory (diatonic chords from the song's key, relative minor/major, dominant 7th, subdominant) to suggest 4-6 common next chords. Suggestions appear as tappable pill buttons in the chord edit bottom sheet, between the fretboard diagram and the quick-select grid. Pills update in real-time as the user types. Uses the song's key if set, otherwise infers from the current chord. Styled with Apple Notes aesthetic: muted label, rounded pills, accent hover/active states, prefers-reduced-motion support. (2026-06-14)
- [x] Recent chords quick-access row in chord edit popup
- Listbox keyboard navigation — added arrow-key (↑↓), Enter/Space, Home/End, and Escape handling for all listbox containers (folder list, song list, setlist list, setlist songs). Includes `.keyboard-focus` accent outline ring, scroll-into-view, mouse/touch auto-clear of focus ring, and input/contenteditable guard. Documented in shortcuts overlay under new "Lists" group. (2026-06-14)
- Save status timestamp in editor nav bar (shows "Saved"/"Editing…"/"Saving…" with relative time, auto-hides after 6s, updates every 15s) (2026-06-14)
- Song count in folder title bar (shows "All Songs · 12" style count in nav bar, updates on folder switch and after song CRUD, extracted getFolderCount() helper) (2026-06-14)
- Ctrl+L to focus song list search bar (standard productivity shortcut, selects existing text for quick replacement, only active in song list view, documented in shortcuts overlay) (2026-06-14)
- Search result highlighting (matching text highlighted in orange within song titles, tags, and preview snippets across list, gallery, and trash views; uses safe HTML escaping with `<mark>` elements) (2026-06-14)
- Search bar clear button (✕ button appears inside the search bar when text is present, one-tap to clear and reset the song list; "No Results" empty state now shows the actual search query) (2026-06-14)
- [x] Section quick-navigation dropdown
- [x] Show current section breadcrumb in editor nav bar — a subtle persistent label that updates while scrolling (e.g., "Chorus 2", "Verse 3"), giving musicians continuous context of where they are in the song. Fades in/out with smooth opacity transition, respects prefers-reduced-motion, clears on song switch and back navigation. (2026-06-14)
- [x] Inline chord detection from bracket notation in lyrics — typing `[G]`, `[Am]`, `[F#m7]`, `[D/F#]` etc in the lyric editor auto-converts the bracket notation into a properly positioned chord marker, removes the brackets from the text, and shows a throttled toast confirmation. Uses the same regex as the import parser for consistency. (2026-06-14)
- [x] BPM indicator in song list and gallery cards — compact orange-tinted badge shows BPM next to the key badge in both list rows and gallery cards, so musicians can quickly identify songs by tempo without opening the editor. Uses `--section-label` accent with subtle background, mono font, and matches existing badge patterns. (2026-06-14)
- [x] BPM accent color in editor nav bar — added missing `.b` class rule so the BPM value in the editor key/BPM badge renders in `--section-label` orange instead of inheriting the default foreground color, matching the visual consistency of `.k` (key, blue accent) and `.c` (capo, green chord). (2026-06-14)
- [x] Comprehensive light theme
- [x] Respect prefers-color-scheme on first launch — currently defaults to dark even on systems set to light mode (2026-06-14)

## TODOs — Refinement & Bug Fixes

### UI Polish
- [x] Song list play/pause button styling — pill button with proper touch targets (26px min-height, 38px min-width), subtle border, accent playing state with opacity pulse animation on the icon (2026-06-13)
- [x] Graceful degradation for large songs — songs with 50+ sections can cause jank when rendering the editor. Add lazy rendering for off-screen sections. (2026-06-13 — fixed: `initSectionObserver` was defined but never called; wiring it up plus lowered threshold to 30 sections)
- [x] Chord diagram panel: swipe left/right on the fretboard area to cycle through all unique chords in the current song (2026-06-14)

### Bugs / Reliability
- [x] Microphone stream cleanup after recording — `getUserMedia()` stream tracks were never stopped, leaving the mic hardware indicator on indefinitely after recording. Added `recordingStream` module-level variable, store reference during `startRecording()`, and call `getTracks().forEach(t => t.stop())` in `stopRecording()`. Also added a double-start guard to prevent a second stream from being opened. (2026-06-14)

### Code Hygiene
- [x] Remove debug console.log statements — 13 debug logs removed from recording/playback code (mediaRecorder, test player, playRecording, toggleRecordingsDropdown, sync queue). Kept error handlers that also show toast notifications. (2026-06-13)
- [x] Extract inline HTML templates to template literals or DocumentFragment functions — app.js has ~200 lines of inline HTML in panel functions that could be modularized (2026-06-14 — added `emptyStateHTML()` helper, `ICONS` constant, converted 7 string-concatenation blocks + 2 folder/setlist picker loops to template literals)

### Performance
- [x] Add a keyboard shortcut to create new song from any view (Ctrl+N already works, but no visual hint exists outside shortcuts overlay) — added ⌘N badge on new song nav button, visible only on desktop via `@media (hover: hover)` (2026-06-14)
- [x] Virtual scrolling for setlist song picker (song list in setlist add modal renders all songs at once — now uses lightweight virtual scroll with 52px fixed-height items, 8-item buffer, and rAF-debounced scroll handler) (2026-06-14)

### Platform
- [ ] iOS build (requires macOS + Xcode) — blocked on hardware
- [ ] Android: test on a real device — touch gestures, audio recording, localStorage limits
- [ ] Android: build and test APK on real device — the symlink workaround may not hold on all devices
- [x] Double-tap editor nav bar title to scroll to top — mobile double-tap + desktop double-click on `.editor-nav .nav-title-wrap` scrolls `song-body` to top, respects `prefers-reduced-motion` (2026-06-15)
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
