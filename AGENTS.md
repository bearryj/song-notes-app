# Song Notes App — AGENTS.md

## Project Overview
Mobile songwriting app — Apple Notes inspired, built for musicians.
Built with Tauri 2.x + Vite + vanilla JS. Targets Android (test) and iOS (ship).

**Project path:** `C:\Users\Justin\song-notes-app`
**Repo:** `https://github.com/bearryj/song-notes-app.git`

## Architecture

### Frontend (`/src-ui/`)
- **index.html** — Mobile-first layout: folder list → song list → editor (navigable views with slide transitions)
- **app.js** — All frontend logic: navigation stack, song CRUD, chord editing, auto-save, transposition, export
- **styles.css** — Apple Notes-inspired dark theme, mobile-first responsive

### Backend (`/src-tauri/`)
- **src/lib.rs** — Rust Tauri commands: song CRUD (save_song, load_songs, delete_song), folder management
- **src/main.rs** — Entry point
- **Cargo.toml** — Dependencies: tauri 2.11.2, serde, serde_json

### Build System
- **package.json** — Vite dev server on port 1422
- **vite.config.js** — Root: src-ui, outDir: ../dist
- **tauri.conf.json** — beforeDevCommand: `npm run dev`, mobile-only (no desktop windows)
- **Android** — `npx tauri android init` already run (NDK 27.1)

## Key Features
1. **Folder navigation** — folder list view → song list (filterable by folder) → editor
2. **Song CRUD** — create, edit, delete songs with auto-save (800ms debounce)
3. **Inline chord editing** — tap on a lyric line to place a chord at that x-position, edit chord name in popup
4. **Chord transposition** — +1/-1 semitone via More menu, transposes all chords in song + key
5. **Export** — plain text (.txt) and markdown (.md) via download
6. **Persistence** — Tauri backend (Rust file I/O) with localStorage fallback for browser dev
7. **Auto-save** — 800ms debounce on all edits (lyrics, sections, chords)
8. **Sample songs** — "Blinding Lights", "Hallelujah", and a blank template on first launch
9. **Search** — filter songs by title in song list

## Data Model
```json
{
  "id": "song_id",
  "title": "Song Name",
  "key": "G",
  "bpm": 120,
  "time_sig": null,
  "tags": [],
  "folder": null,
  "sections": [
    {
      "type": "Chorus",
      "lines": [
        { "text": "lyrics here", "chords": [{"x": 50, "name": "G"}] }
      ]
    }
  ],
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

## Tech Stack Rules
1. **Tauri v2 + Vite** — static imports only (`@tauri-apps/api/core`)
2. **Vanilla JS only** — no frameworks
3. **Mobile-first UI** — touch targets ≥44px, no hover states, safe area insets
4. **iOS primary target** — Android for testing, iOS for shipping
5. **Rust backend** — all persistent I/O through Tauri commands

## Development Workflow
1. **Review AGENTS.md** — understand current state before planning
2. **Plan → implement → test → commit** — don't skip steps
3. **Feature branches** for significant changes
4. **Clear commit messages** — describe what and why
5. **Test on Android** via `npx tauri android dev` (or `npx tauri android build` for APK)
6. **iOS builds** require macOS — use GitHub Actions or Mac later

## Android Build
```bash
# Prerequisites — already set up
export ANDROID_HOME="/c/Users/Justin/android-sdk"
export JAVA_HOME="C:\Program Files\Eclipse Adoptium\jdk-21.0.7.6-hotspot"
export PATH="/c/Users/Justin/.cargo/bin:$PATH"

# Build APK
cd /c/Users/Justin/song-notes-app && npx tauri android build

# Run on connected device / emulator
npx tauri android dev
```

## Common Pitfalls
- `cmd /c` from MSYS bash needs `//c` (double slash) to avoid path mangling
- PowerShell paths with spaces need single-quoting from MSYS
- iOS init not available on Windows — use Mac for iOS builds
- `cargo tauri android` needs ANDROID_HOME and JAVA_HOME set
- Rust data model uses `#[serde(rename = "type")]` for section type field (reserved word in Rust)
- `tauri.conf.json` has empty `windows: []` for mobile-only mode

## Features Implemented
- [x] Mobile-first navigation (folders → songs → editor with slide transitions)
- [x] Song CRUD with Tauri backend + localStorage fallback
- [x] Inline chord editing (pixel-positioned, tap to add, popup to edit/remove)
- [x] Apple Notes-inspired dark theme
- [x] Auto-save with 800ms debounce
- [x] Chord transposition (+1/-1 semitone, all chords + key)
- [x] Export (txt, markdown)
- [x] Sample songs on first launch
- [x] Folder management (create, navigate, count songs)
- [x] Song search/filter
- [x] Android build targets (NDK 27.1)
- [x] Rust backend compiles clean

## Features To Build
- [ ] Audio recording
- [ ] Version history
- [ ] Tap tempo
- [ ] Import (txt, PDF)
- [ ] Swipe-to-delete on list items
- [ ] App icon (custom)
- [ ] Splash screen
- [ ] Offline-first sync
- [ ] iOS build pipeline
