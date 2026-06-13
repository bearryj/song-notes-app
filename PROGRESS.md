# Song Notes App — Progress Tracker

## Last Updated
2026-06-13 by OWL (interactive tutorial song — Welcome to Song Notes)

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
- [x] Quick song switcher in editor (prev/next or swipe between songs in current folder) (2026-06-12) — compact ‹‹ ›› buttons in editor nav bar, wraps around, slide transition, auto-saves current song, mirrors sort order
22. [x] Chord ribbon — make collapsible (2026-06-12) — smooth max-height transition, localStorage persistence, toggle stays visible when collapsed
23. [x] Gallery view with card layout (2026-06-12) — 2-column grid with song cards showing title, key badge, chord preview chips, section count, tags, date; staggered entrance animation; pin/delete action buttons; persisted to localStorage; re-renders on toggle

## Next Up (2026-06-12 — OWL review)
### Bugs / Reliability
- [x] Metronome AudioContext never closed — `metroAudioCtx` is created on first use but `.close()` is never called; on mobile this can hit the browser limit of 6 AudioContexts. Add cleanup on metro stop/panel close. (2026-06-12) — metroStop() now closes AudioCtx + nulls reference
- [x] `metroTimerID` not cleared on page navigation away from editor — if metronome is playing and user navigates back, the interval keeps running in the background. Add cleanup in the back-navigation handler. (2026-06-12) — metroStop() called in switchToSong() + saveCurrentSongAndGoBack()
- [x] `sessionTimerInterval` not cleared on song list re-render — if `startSessionTimer` is called multiple times (e.g. re-opening editor), the old interval leaks. Guard with existing check at line 1014 but verify it's hit in all re-entry paths. (2026-06-12) — already guarded: startSessionTimer() calls stopSessionTimer() first
- [x] `undoTimer` (line 1129) not cleared on song switch — stale undo buffer from a previous song could restore wrong data. Clear on `switchToSong()`. (2026-06-12) — clearUndo() called in switchToSong()

### Performance / Code Health
- [x] `app.js` is 5,639 lines / ~170KB — extract modules (e.g. `metro.js`, `editor.js`, `songlist.js`, `export.js`) to reduce main file and improve maintainability. Vite handles bundling. (2026-06-12) — extracted `modules/metro.js` (metronome engine + tap tempo, 219 lines); app.js down from 5,858 lines
- [x] `styles.css` is 4,191 lines / ~72KB — split into feature-scoped files (e.g. `editor.css`, `toolbar.css`, `metronome.css`) and import in `index.html`. (2026-06-12) — split into 13 modules: base, views, editor, gallery, theme, setlist, share, plugins, metronome, stats, tags, picker, extras; largest is 1203 lines; Vite bundles to single 69KB/12KB-gzipped output
- [x] 178 `addEventListener` calls with only a handful of `removeEventListener` — audit for leaked listeners on re-rendered DOM elements (especially song list items, toolbar buttons, and sheet modals). (2026-06-12) — converted song list per-item listeners to delegation on #song-list container; WeakMap for swipe state; 0 listeners added per renderSongList() call
- [x] `innerHTML` used 20+ times — audit for XSS vectors (2026-06-12) — fixed 3 missing: v.key in history list meta, version.key/song.key in diff header, rec.data in recording data-url. Added Ctrl+N new song shortcut + docs in shortcuts overlay.

### UX Polish
- [x] Song list play/pause button styling — refined to Apple Notes monochrome inline text indicator with animated recording dot, replacing green pill button (2026-06-13)
- [ ] No "delete all recordings" option — audio recordings are base64-encoded and stored per-song; a song with many recordings can balloon in size. Add a "clear recordings" button in the audio panel. (already existed — Delete All button in recordings dropdown)
- [x] No bulk operations on songs — can't multi-select to delete, move, or add to setlist. Long-press multi-select would be natural on mobile. (2026-06-12) — long-press enters multi-select, right-click on desktop, tap to toggle, bottom bar with pin/duplicate/folder/setlist/delete + Select All/Deselect All toggle
- [x] Setlist chord chart print doesn't include capo transposition — the print view shows raw chords, not capo-adjusted chords. Fix to match the capo-per-song feature. (2026-06-12) — showSetlistPrintPreview() now applies both entry.capo + entry.transpose semitones to displayed chords
- [x] No song count in folder headers — folders show name but not how many songs they contain. Add a small count badge. (already existed — item-meta count in renderFolders())
- [x] Search doesn't search chord content — only searches title/tags. Musicians often remember a chord progression, not the title. Index chord names in search. (2026-06-12) — added chord name matching in renderSongList() filter
- [x] No "recently deleted" / trash — deleted songs are gone forever. Add a 30-day trash folder with restore capability. (2026-06-12) — trash array in localStorage, "Recently Deleted" smart folder, restore + permanent delete with confirm sheets, 30-day auto-expiry purge on init, days-remaining badge per item

### Platform
- [ ] iOS build (requires macOS + Xcode) — blocked on hardware
- [ ] Android: test on a real device — the emulator may not reveal touch/gesture issues, audio recording problems, or localStorage quota limits

## Next Up — Round 2 (2026-06-12 — OWL review)
### Musician Workflow
- [x] Chord sheet display modes — "lyrics only", "chords only", "chords + lyrics" toggle for the editor view. Musicians use chord sheets differently in rehearsal vs. performance. (2026-06-12) — displayMode state persisted to localStorage, nav bar button cycles modes (≡/♫/𝄞 icons), toolbar View section button, CSS classes .display-lyrics/.display-chords/.display-both on #song-body
- [x] Strumming pattern notation — simple text-based pattern editor (e.g. "D-DU-UDU") per section, displayed above the chord ribbon. No audio, just visual reference. (2026-06-13) — toggle button (𝅘𝅥) in section header controls, inline input with clear button, persisted to section data, included in export (txt/markdown/ChordPro), print preview, and share codes
- [x] Song memo / notes field — a free-text "Notes" area per song (not part of the chord/lyric body) for ideas, reminders, co-writer credits, recording notes. Shown in info panel. (2026-06-13) — bottom sheet panel with song stats (key, BPM, sections, lines, words, chords, unique chords, tags, dates) + editable textarea with 600ms debounced auto-save; included in text, markdown, and chordPro exports; persisted to song.notes field; restored from share codes
- [x] Tuner / pitch detection — use `getUserMedia` + AnalyserNode + autocorrelation to detect pitch from mic. Simple chromatic tuner panel (like a guitar tuner app). Already have mic permission flow for recording. (2026-06-13) — autocorrelation engine with parabolic interpolation, 48kHz sample rate, RMS gate, guitar string selector (E2-A2-D3-G3-B3-E4), cents needle meter, sharp/flat/in-tune display, start/stop button, cleanup on nav/back
- [x] Capo chord diagram view — when capo is set, optionally show chord diagrams with capo fret indicated and "real" chord names in parentheses. (2026-06-13) — song.capo field, +/− buttons in Song Settings sheet, capo fret indicator (blue bar + "C" label) on fretboard SVG, "Capo N — sounds as X" label in diagram panel, capo displayed in editor nav badge (key · bpm · capo N)

### Data & Sync
- [x] Cloud backup / sync — songs stored only in localStorage are lost on device change. Add optional cloud sync (e.g. a simple REST API, or even just export/import a full backup JSON). At minimum: "Export All Songs" and "Import Backup" buttons. (2026-06-13) — exportAllSongs() downloads full JSON backup (songs + folders + setlists + trash) with timestamp; importBackup() merges from JSON file, skipping duplicate titles; both accessible from toolbar sheet (Backup ⊞ in Export, Restore ⊟ in Organize)
- [x] Song-level auto-backup — keep last N auto-saved snapshots separate from version history, so a user can recover from a bad edit even after auto-save overwrites. (2026-06-13) — sn_auto_backups localStorage key, 10 snapshots per song, auto-backup section in history panel with diff view + restore, cleanup on permanent delete
- [x] Duplicate song detection — warn when creating/importing a song with the same title as an existing one. (2026-06-13) — isDuplicateTitle() helper, blocks creation with error toast, skips file imports with count, blocks share code import with guidance

### Editor Quality of Life
- [x] Adjustable editor font size — A-/A+ buttons in editor nav bar (13-24px), CSS custom property --editor-font-size scales lyrics, chords, section headers. Persisted to localStorage. (2026-06-13)
- [x] Section templates beyond song structure — "Pre-Chorus", "Bridge", "Tag", "Coda", "Outro", "Intro" as one-tap section types with appropriate default labels. (2026-06-13) — section type picker bottom sheet with 9 types (Verse, Verse 2, Chorus, Pre-Chorus, Bridge, Tag, Coda, Outro, Intro); Tag + Coda added to dropdown, ChordPro export map, and ChordPro import map
- [x] Line/section find — Ctrl+F to search within the current song's lyrics. Find bar at bottom of editor with match count, prev/next navigation, Enter/Shift+Enter to cycle, debounced highlight, Escape to close. (2026-06-13)
- [x] Auto-capitalize section headers — when typing "verse 1" auto-suggest "Verse 1" (matching existing section type labels). (2026-06-13) — converted <select> to <input list="section-type-list"> with <datalist> suggestions; auto-capitalize on input/change matches known types case-insensitively, capitalizes first letter of each word for custom labels

### Onboarding & Discovery
- [x] First-run onboarding — 3-4 swipeable cards explaining: create a song, add chords, use the toolbar, setlist mode. Shown only on first launch. (2026-06-13) — 4-card swipeable walkthrough with dot navigation, skip/next buttons, swipe gestures, bounce animation, Apple Notes dark theme, persisted via sn_onboarding_seen localStorage key
- [x] Interactive tutorial song — "Welcome to Song Notes" sample song with pre-filled chords and annotations explaining features (tap this chord, swipe here, etc.). (2026-06-13) — ★ Welcome to Song Notes pinned tutorial song with 5 annotated sections (Intro/Verse/Chorus/Bridge/Outro), tutorial badge in list + gallery views, auto-pinned on first launch
- [ ] Feature discovery hints — subtle one-time tooltips for power features (swipe-to-action, long-press multi-select, gallery view toggle) that dismiss after first use.

### Performance & Robustness
- [ ] Virtual scrolling for song list — with hundreds of songs, rendering all DOM nodes is slow. Virtualize the list to only render visible items.
- [x] Debounce localStorage writes — every save serializes the full songs array to localStorage. With many songs this blocks the UI. Debounce or diff-write. (2026-06-13) — added queueLocalStorageSave() with 2s debounce window; flushLocalStorage() for synchronous writes on delete/restore/emergency; all 6 original setItem call sites converted
- [x] Audio recording compression — adds a quality/compression option to reduce storage. Show per-song recording size in info panel. (2026-06-13) — formatBytes() + computeAudioSize() helpers, recording stat card in stats panel Overview section, amber color, only shown when recordings exist
- [ ] Graceful degradation for large songs — songs with 50+ sections can cause jank when rendering the editor. Add lazy rendering for off-screen sections.

### Platform
- [ ] iOS build (requires macOS + Xcode) — blocked on hardware
- [ ] Android: test on a real device — touch gestures, audio recording, localStorage limits
- [ ] Android: build and test APK on real device — the symlink workaround may not hold on all devices
- [ ] Desktop Tauri build — the app is mobile-only in tauri.conf.json; enable desktop targets for Windows/Mac/Linux distribution
- [ ] Keyboard shortcuts for desktop — Ctrl+S (save), Ctrl+Z (undo), Ctrl+F (find), Ctrl+P (print), arrow keys for song navigation. Currently only Ctrl+/ and Ctrl+Z are documented.
- [x] PWA manifest + service worker (2026-06-12) — manifest.json with standalone display + maskable icons, 192/512 SVG icons (♫ in white on black), service worker with network-first strategy + offline caching, meta tags for apple-mobile-web-app/mobile-web-app-capable, safe-area-inset for notched devices, overscroll-behavior in standalone mode

## Newly Discovered TODOs
- [x] Add loading spinner/skeleton screens for song list (2026-06-11) — shimmer skeleton with staggered animation on init + refresh
- [x] Song list sort options (recent, A-Z, Z-A, key) (2026-06-11) — sort button in nav bar, popover with 4 modes, pinned always first, persisted to localStorage
- [x] Support drag files into app for import (desktop) (2026-06-11) — drag-and-drop overlay on #app container, filters .txt/.md, reuses importFiles(), bounce animation
- [x] Chord progression ribbon in editor (2026-06-11) — horizontal strip showing unique chords per section, tap to highlight + scroll to first occurrence in body
- [x] Swipe-to-action on song list items (2026-06-11) — swipe left to reveal pin (★) and delete (✕) action buttons, snap-open/close with smooth animation, tap-outside-to-close
- [x] Auto-save song title on input (2026-06-11) — title input triggers auto-save with 1200ms debounce, syncs title into song object before save
- [x] Song writing session timer (2026-06-11) — elapsed editing time shown in editor nav, persists session_ms to song data, accumulates across sessions
- [x] Error recovery UI — init error state with retry button + global unhandledrejection/error handlers (2026-06-12) — try/catch around init(), shows error-state with Try Again button, window listeners for uncaught errors surface toast notifications
- [x] Offline indicator + sync queue for mobile (show connection status, queue saves when offline, sync on reconnect) (2026-06-12) — fixed-position top banner with pulsing red dot, deduplicating sync queue persisted to localStorage, auto-flush on reconnect
- [x] ChordPro import + valid ChordPro v6 export (2026-06-12) — .cho/.crd/.chopro file support, auto-detection via directive scanning, full parser for {title:}/{key:}/{start_of_} sections and [chord] tags, dedicated export builder producing valid ChordPro v6 with {start_of_}/{end_of_} section directives
- [x] Drag-and-drop import now supports ChordPro files (.cho/.crd/.chopro) matching file picker (2026-06-12) — fixed filter regex, updated error toast message
- [x] Optimized esc() helper — replaced DOM-based escaping with regex replace (2026-06-12) — eliminates 33+ unnecessary createElement calls, many in hot render loops
- [x] Auto-save timer flush on song switch + back navigation (2026-06-12) — clearTimeout + reset hasChanges + updateSaveDot in switchToSong() and saveCurrentSongAndGoBack() to prevent stale debounced writes from corrupting state
- [x] Song content preview in list view (2026-06-12) — chord chips + first lyric line snippet under each title, two-line layout with .list-item-main wrapper, scoped to .swipe-content.list-item to avoid affecting folder items
|- [x] Multi-select mode — long-press (touch) or right-click (desktop) to enter, tap to toggle selection, bottom bar with Select All/Deselect All, Pin, Duplicate, Move to Folder, Add to Setlist, Delete (2026-06-12)
|- [x] Recording playback from song list — play/pause button (▶ N) on songs with recordings, toggles to pause (❚❚ N) in orange, auto-resets on song switch or playback end (2026-06-13)
|- [x] Recording playback fix — fixed base64 data URL corruption from HTML-escaping, added MIME type detection, audio constraints for quality (2026-06-13)

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
