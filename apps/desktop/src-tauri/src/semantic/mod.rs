pub mod chunker;
pub mod embedder;
pub mod store;

use crate::error::AppError;
use crate::state::AppState;
use embedder::{Embedder, HashEmbedder};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};
use store::{content_hash, VectorStore};
use tauri::Manager;

// ─── SemanticState ────────────────────────────────────────────────────────────

/// Process-wide semantic index state, managed by Tauri.
///
/// The [`VectorStore`] owns the SQLite connection and all persistence logic.
/// The [`Embedder`] is pluggable: swap `HashEmbedder` for a real model
/// (fastembed / candle) by passing a different `Box<dyn Embedder>` to
/// [`SemanticState::with_embedder`].
pub struct SemanticState {
    pub store: VectorStore,
    pub embedder: Box<dyn Embedder>,
}

impl SemanticState {
    /// Initialise using the default [`HashEmbedder`] (placeholder quality).
    pub fn new(app_data_dir: &Path) -> Result<Self, AppError> {
        let db_path = app_data_dir.join("semantic_index.db");
        let store = VectorStore::open(&db_path)?;
        Ok(Self {
            store,
            embedder: Box::new(HashEmbedder),
        })
    }

    /// Swap in an alternative embedder.  The new embedder's `dimensions()`
    /// must equal [`store::VECTOR_DIMS`] (384) or KNN inserts will panic in
    /// debug mode and produce wrong results in release.
    #[allow(dead_code)]
    pub fn with_embedder(mut self, embedder: Box<dyn Embedder>) -> Self {
        self.embedder = embedder;
        self
    }
}

// ─── Serde types returned to the frontend ─────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct IndexStatusResult {
    pub note_count: usize,
    pub chunk_count: usize,
    pub dimensions: usize,
}

#[derive(Debug, Serialize)]
pub struct ReindexResult {
    pub indexed: usize,
    pub skipped: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub note_path: String,
    pub chunk_text: String,
    pub distance: f64,
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Counts of indexed notes and chunks, plus the vector dimension.
#[tauri::command]
pub fn semantic_index_status(app: tauri::AppHandle) -> Result<IndexStatusResult, AppError> {
    let state = app.state::<SemanticState>();
    let s = state.store.status()?;
    Ok(IndexStatusResult {
        note_count: s.note_count,
        chunk_count: s.chunk_count,
        dimensions: s.dimensions,
    })
}

/// Walk the active workspace, chunk+embed every markdown file, and upsert
/// changed notes.  Unchanged files (same mtime + content hash) are skipped.
/// Notes whose files have been deleted are pruned from the store.
#[tauri::command]
pub fn semantic_reindex_all(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<ReindexResult, AppError> {
    let workspace_state = app.state::<AppState>().get_or_create(webview.label());
    let root = workspace_state
        .workspace_root
        .read()
        .clone()
        .ok_or(AppError::NoWorkspace)?;

    let semantic = app.state::<SemanticState>();

    // Collect all markdown files in the workspace (gitignore-aware).
    let md_files = collect_markdown_files(&root);

    let mut indexed = 0usize;
    let mut skipped = 0usize;

    for path in &md_files {
        match index_one_file(path, &semantic) {
            Ok(true) => indexed += 1,
            Ok(false) => skipped += 1,
            Err(e) => eprintln!("semantic: skipping {}: {e}", path.display()),
        }
    }

    // Remove chunks for notes that no longer live in the workspace.
    let md_set: std::collections::HashSet<String> = md_files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let known = semantic.store.known_paths()?;
    let mut removed = 0usize;
    for known_path in &known {
        if !md_set.contains(known_path) {
            semantic.store.remove_note(known_path)?;
            removed += 1;
        }
    }

    Ok(ReindexResult {
        indexed,
        skipped,
        removed,
    })
}

/// Index or refresh a single note by absolute path.
#[tauri::command]
pub fn semantic_index_note(path: String, app: tauri::AppHandle) -> Result<bool, AppError> {
    let semantic = app.state::<SemanticState>();
    index_one_file(Path::new(&path), &semantic)
}

/// Remove all chunks belonging to a note.
#[tauri::command]
pub fn semantic_remove_note(path: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let semantic = app.state::<SemanticState>();
    semantic.store.remove_note(&path)
}

/// Return the nearest `limit` chunks to `query`, ordered by cosine distance.
#[tauri::command]
pub fn semantic_search(
    query: String,
    limit: Option<u32>,
    app: tauri::AppHandle,
) -> Result<Vec<SearchHit>, AppError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let semantic = app.state::<SemanticState>();
    let limit = limit.unwrap_or(10) as usize;

    let embeddings = semantic.embedder.embed_batch(&[query])?;
    let query_vec = &embeddings[0];

    let hits = semantic
        .store
        .knn_search(query_vec, limit)?
        .into_iter()
        .map(|h| SearchHit {
            note_path: h.note_path,
            chunk_text: h.chunk_text,
            distance: h.distance,
        })
        .collect();

    Ok(hits)
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Read, chunk, embed, and upsert one markdown file.
/// Returns `Ok(true)` if the file was (re)indexed, `Ok(false)` if unchanged.
fn index_one_file(path: &Path, semantic: &SemanticState) -> Result<bool, AppError> {
    let path_str = path.to_string_lossy();

    // mtime in seconds since the Unix epoch.
    let mtime = path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let raw = std::fs::read(path)?;
    let hash = content_hash(&raw);

    if semantic.store.is_unchanged(&path_str, mtime, hash)? {
        return Ok(false);
    }

    let text = String::from_utf8_lossy(&raw).into_owned();
    let chunks = chunker::chunk_markdown(&text);
    if chunks.is_empty() {
        // Empty file: remove any stale entries and record as zero-chunk note.
        semantic.store.remove_note(&path_str)?;
        return Ok(true);
    }

    let chunk_strings: Vec<String> = chunks.clone();
    let embeddings = semantic.embedder.embed_batch(&chunk_strings)?;

    semantic
        .store
        .upsert_note(&path_str, mtime, hash, &chunks, &embeddings)?;

    Ok(true)
}

/// Walk `root` and collect all `.md` file paths.
fn collect_markdown_files(root: &PathBuf) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|ft| ft.is_dir()) {
            if entry.file_name() == "node_modules" {
                continue;
            }
            continue;
        }
        if entry.file_type().is_some_and(|ft| ft.is_file())
            && entry.path().extension().and_then(|e| e.to_str()) == Some("md")
        {
            files.push(entry.path().to_path_buf());
        }
    }
    files
}

// ─── Initialisation helper (called from lib.rs setup) ────────────────────────

/// Initialise a `SemanticState` and register it with the Tauri app.
/// Logs a warning and skips managing on failure (commands will return
/// `Database` errors until the app is restarted).
pub fn init(app: &tauri::AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        eprintln!("semantic: could not resolve app data dir; semantic index disabled");
        return;
    };
    match SemanticState::new(&data_dir) {
        Ok(state) => {
            app.manage(state);
        }
        Err(e) => {
            eprintln!("semantic: init failed ({e}); semantic index disabled");
        }
    }
}
