use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// ===== Data Model =====

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChordFile {
    pub x: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineFile {
    pub text: String,
    pub chords: Vec<ChordFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionFile {
    #[serde(rename = "type")]
    pub section_type: String,
    pub lines: Vec<LineFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFile {
    pub data: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongFile {
    pub id: String,
    pub title: String,
    pub key: String,
    pub bpm: Option<u32>,
    pub time_sig: Option<String>,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub sections: Vec<SectionFile>,
    pub audio: Option<Vec<AudioFile>>,
    pub created_at: String,
    pub updated_at: String,
}

// ===== State =====

pub struct AppState {
    pub data_dir: PathBuf,
}

fn get_data_dir(app: &tauri::AppHandle) -> PathBuf {
    let path = app
        .path()
        .app_data_dir()
        .expect("Failed to get app data dir");
    fs::create_dir_all(&path).ok();
    path
}

fn song_path(data_dir: &PathBuf, id: &str) -> PathBuf {
    let songs_dir = data_dir.join("songs");
    fs::create_dir_all(&songs_dir).ok();
    songs_dir.join(format!("{}.json", id))
}

// ===== Tauri Commands =====

#[tauri::command]
fn ensure_data_dir(state: tauri::State<AppState>) -> Result<String, String> {
    fs::create_dir_all(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(state.data_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn load_songs(state: tauri::State<AppState>) -> Result<Vec<SongFile>, String> {
    let songs_dir = state.data_dir.join("songs");
    if !songs_dir.exists() {
        return Ok(vec![]);
    }
    let mut songs = Vec::new();
    let entries = fs::read_dir(&songs_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
            let content = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            if let Ok(song) = serde_json::from_str::<SongFile>(&content) {
                songs.push(song);
            }
        }
    }
    // Sort by updated_at descending
    songs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(songs)
}

#[tauri::command]
fn save_song(state: tauri::State<AppState>, song: SongFile) -> Result<(), String> {
    let path = song_path(&state.data_dir, &song.id);
    let json = serde_json::to_string_pretty(&song).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_song(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let path = song_path(&state.data_dir, &id);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn load_folders(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let path = state.data_dir.join("_folders.json");
    if !path.exists() {
        return Ok(vec!["All Songs".to_string()]);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let folders: Vec<String> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(folders)
}

#[tauri::command]
fn save_folders(state: tauri::State<AppState>, folders: Vec<String>) -> Result<(), String> {
    let path = state.data_dir.join("_folders.json");
    let json = serde_json::to_string_pretty(&folders).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ===== App Entry =====

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = get_data_dir(&app.handle());
            app.manage(AppState { data_dir });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_data_dir,
            load_songs,
            save_song,
            delete_song,
            load_folders,
            save_folders,
            read_file_content,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}