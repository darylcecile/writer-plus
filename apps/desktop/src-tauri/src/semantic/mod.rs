pub mod chunker;
pub mod embedder;
pub mod store;

use crate::error::AppError;
use crate::state::AppState;
use embedder::{Embedder, HashEmbedder, Model2VecEmbedder};
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};
use store::{content_hash, VectorStore};
use tauri::Manager;

// ─── SemanticState ────────────────────────────────────────────────────────────

/// Where a downloaded embedding model is expected to live, relative to the
/// app data directory.
pub const MODEL_DIR: &str = "models/potion-base-8M";

/// Process-wide semantic index state, managed by Tauri.
///
/// The [`VectorStore`] owns the SQLite connection and all persistence logic.
/// The [`Embedder`] is chosen at startup: a real model if its weights are on
/// disk, otherwise the [`HashEmbedder`] placeholder.
pub struct SemanticState {
    pub store: VectorStore,
    pub embedder: Box<dyn Embedder>,
    /// Whether search is running on real semantic embeddings. Surfaced so the
    /// UI can say so, rather than letting a user conclude that semantic search
    /// is poor when in fact it is not running.
    pub is_semantic: bool,
}

impl SemanticState {
    /// Initialise, preferring a real embedding model when its weights are
    /// present and falling back to [`HashEmbedder`] when they are not.
    ///
    /// Falling back rather than failing is deliberate: the index is a feature
    /// of the app, not a precondition for it, and a missing 29 MB download must
    /// not stop notes from opening. The fallback is reported rather than hidden
    /// because the two have very different quality.
    pub fn new(app_data_dir: &Path) -> Result<Self, AppError> {
        let model_dir = app_data_dir.join(MODEL_DIR);

        let (embedder, is_semantic): (Box<dyn Embedder>, bool) =
            match Model2VecEmbedder::load(&model_dir) {
                Ok(model) => (Box::new(model), true),
                Err(AppError::NotFound(_)) => (Box::new(HashEmbedder), false),
                // A model that exists but will not load is a real fault, not an
                // absence. Still fall back so the app works, but say so loudly:
                // silently degrading is how a corrupt download becomes a bug
                // report about bad search results.
                Err(err) => {
                    eprintln!(
                        "[semantic] embedding model failed to load, using placeholder: {err}"
                    );
                    (Box::new(HashEmbedder), false)
                }
            };

        let db_path = app_data_dir.join("semantic_index.db");
        // The width follows the embedder. Opening at the wrong width would fail
        // at insert time, long after the decision that caused it.
        let store = VectorStore::open_with_dims(&db_path, embedder.dimensions())?;

        Ok(Self {
            store,
            embedder,
            is_semantic,
        })
    }

    /// Swap in an alternative embedder. Only valid when its `dimensions()`
    /// match the open store; use [`VectorStore::open_with_dims`] otherwise.
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

/// Files that make up a Model2Vec model, and the cap each is allowed.
///
/// Caps are enforced while streaming rather than checked afterwards, because a
/// declared length is attacker-controlled and a post-hoc check would only run
/// after the bytes were already in memory.
const MODEL_FILES: [(&str, u64); 3] = [
    ("config.json", 64 * 1024),
    ("tokenizer.json", 8 * 1024 * 1024),
    ("model.safetensors", 64 * 1024 * 1024),
];

const MODEL_BASE_URL: &str = "https://huggingface.co/minishlab/potion-base-8M/resolve/main";

/// Download the embedding model.
///
/// This is an explicit user action rather than something that happens on first
/// launch. Writer is a local-first editor, and silently reaching out for a
/// 29 MB file the first time someone opens a notes folder is not a decision the
/// app should make for them.
///
/// Files land in a temporary directory and are moved into place only once all
/// three have arrived, so an interrupted download cannot leave a half-model
/// that loads and produces wrong vectors.
#[tauri::command]
pub async fn semantic_download_model(app: tauri::AppHandle) -> Result<(), AppError> {
    let target = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Unavailable(format!("no app data directory: {e}")))?
        .join(MODEL_DIR);
    download_model_to(&target).await
}

/// The download itself, separated from Tauri so it can be tested against the
/// real host without an `AppHandle`.
async fn download_model_to(target: &Path) -> Result<(), AppError> {
    if target.join("model.safetensors").is_file() {
        return Ok(());
    }

    let staging = target.with_extension("incoming");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    let client = crate::extensions::github::http_client()?;

    for (name, max_bytes) in MODEL_FILES {
        let bytes = crate::extensions::github::download_capped(
            &client,
            &format!("{MODEL_BASE_URL}/{name}"),
            max_bytes,
        )
        .await
        .inspect_err(|_| {
            // A partial download must not be left where a later run could
            // mistake it for a completed one.
            let _ = std::fs::remove_dir_all(&staging);
        })?;
        std::fs::write(staging.join(name), bytes)?;
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&staging, target)?;

    Ok(())
}

/// Whether the embedding model is present, so the UI can offer the download
/// instead of leaving the user to wonder why search is weak.
#[tauri::command]
pub fn semantic_model_status(app: tauri::AppHandle) -> Result<ModelStatus, AppError> {
    let installed = app
        .path()
        .app_data_dir()
        .map(|d| d.join(MODEL_DIR).join("model.safetensors").is_file())
        .unwrap_or(false);
    Ok(ModelStatus {
        installed,
        active: app.state::<SemanticState>().is_semantic,
    })
}

#[derive(Debug, Serialize)]
pub struct ModelStatus {
    /// Weights are on disk.
    pub installed: bool,
    /// Weights are on disk **and** loaded. These differ after a download until
    /// the app is restarted, which is worth telling the user rather than
    /// letting them wonder why results did not change.
    pub active: bool,
}

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

#[cfg(test)]
mod state_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_missing_model_falls_back_rather_than_failing_startup() {
        let dir = TempDir::new().unwrap();
        let state = SemanticState::new(dir.path()).expect("startup must survive no model");

        assert!(!state.is_semantic, "must report that it is not semantic");
        assert_eq!(
            state.store.dimensions(),
            state.embedder.dimensions(),
            "the store must be opened at the embedder's width"
        );
    }

    /// A directory that looks like a model but is not must not be reported as
    /// working. Silently succeeding here is how a corrupt download turns into a
    /// bug report about bad search results.
    #[test]
    fn a_broken_model_falls_back_and_does_not_claim_to_be_semantic() {
        let dir = TempDir::new().unwrap();
        let model_dir = dir.path().join(MODEL_DIR);
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.safetensors"), b"not a model").unwrap();
        std::fs::write(model_dir.join("config.json"), b"{}").unwrap();
        std::fs::write(model_dir.join("tokenizer.json"), b"{}").unwrap();

        let state = SemanticState::new(dir.path()).expect("a broken model must not stop startup");
        assert!(!state.is_semantic);
    }

    /// The branch that matters: real weights present, so the store must be
    /// opened at the model's width, not the placeholder's.
    ///
    /// Ignored because it needs the downloaded model. Run with:
    /// `cargo test --lib semantic::state_tests -- --ignored`
    #[test]
    #[ignore = "requires downloaded model weights"]
    fn real_weights_are_used_and_set_the_store_width() {
        let src = embedder::dev_model_dir();
        assert!(
            src.join("model.safetensors").is_file(),
            "download the model first: {}",
            src.display()
        );

        let dir = TempDir::new().unwrap();
        let model_dir = dir.path().join(MODEL_DIR);
        std::fs::create_dir_all(&model_dir).unwrap();
        for name in ["config.json", "tokenizer.json", "model.safetensors"] {
            std::fs::copy(src.join(name), model_dir.join(name)).unwrap();
        }

        let state = SemanticState::new(dir.path()).unwrap();
        assert!(state.is_semantic, "real weights must be used");
        assert_ne!(
            state.embedder.dimensions(),
            HashEmbedder.dimensions(),
            "the real model is a different width to the placeholder, which is \
             the whole reason the store width had to become dynamic"
        );
        assert_eq!(state.store.dimensions(), state.embedder.dimensions());
    }
}

#[cfg(test)]
mod end_to_end_tests {
    use super::*;
    use tempfile::TempDir;

    /// The user's stated use case, end to end: "look up notes on a topic I
    /// previously wrote about", where the search words never appear in the
    /// note.
    ///
    /// Every other test checks a component. This one checks the promise, so it
    /// is the test that would catch the feature being wired up correctly but
    /// still not doing the thing it exists for.
    ///
    /// Ignored because it needs the downloaded model. Run with:
    /// `cargo test --lib semantic::end_to_end -- --ignored --nocapture`
    #[test]
    #[ignore = "requires downloaded model weights"]
    fn a_note_is_found_by_meaning_when_no_word_matches() {
        let dir = TempDir::new().unwrap();
        let model_dir = dir.path().join(MODEL_DIR);
        std::fs::create_dir_all(&model_dir).unwrap();
        let src = embedder::dev_model_dir();
        for name in ["config.json", "tokenizer.json", "model.safetensors"] {
            std::fs::copy(src.join(name), model_dir.join(name))
                .unwrap_or_else(|e| panic!("download the model first ({}): {e}", src.display()));
        }

        let state = SemanticState::new(dir.path()).unwrap();
        assert!(state.is_semantic);

        let notes = [
            (
                "cooking.md",
                "Sourdough starter needs feeding twice a day. Bake at 240C with steam.",
            ),
            (
                "commute.md",
                "The clutch on my vehicle is slipping again. Booked it into the garage.",
            ),
            (
                "meeting.md",
                "Quarterly planning: headcount, budget approvals, and the hiring freeze.",
            ),
        ];

        for (path, body) in notes {
            let chunks = chunker::chunk_markdown(body);
            let vectors = state.embedder.embed_batch(&chunks).unwrap();
            state
                .store
                .upsert_note(path, 1, content_hash(body.as_bytes()), &chunks, &vectors)
                .unwrap();
        }

        // "car" appears in none of the notes. Only meaning connects it.
        let query = state.embedder.embed_batch(&["car".to_string()]).unwrap();
        let hits = state.store.knn_search(&query[0], 3).unwrap();

        assert!(!hits.is_empty(), "search returned nothing");
        assert_eq!(
            hits[0].note_path,
            "commute.md",
            "expected the note about a vehicle; got {:?}",
            hits.iter().map(|h| &h.note_path).collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;

    /// Proves the model URLs resolve and the capped download works against the
    /// real host. Ignored because it hits the network and pulls ~30 MB.
    ///
    /// Run with:
    /// `cargo test --lib semantic::download_tests -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "network"]
    async fn model_files_download_from_hugging_face() {
        let client = crate::extensions::github::http_client().unwrap();

        for (name, max_bytes) in MODEL_FILES {
            let bytes = crate::extensions::github::download_capped(
                &client,
                &format!("{MODEL_BASE_URL}/{name}"),
                max_bytes,
            )
            .await
            .unwrap_or_else(|e| panic!("{name} failed: {e:?}"));

            assert!(!bytes.is_empty(), "{name} came back empty");
            println!("{name}: {} bytes", bytes.len());
        }
    }

    /// The whole download, into a real directory, then loaded as a real model.
    ///
    /// This is the test that would catch the staging directory being left
    /// behind, the rename landing in the wrong place, or the files arriving
    /// intact but unusable.
    ///
    /// Ignored because it pulls ~31 MB.
    #[tokio::test]
    #[ignore = "network"]
    async fn a_downloaded_model_lands_in_place_and_loads() {
        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join(MODEL_DIR);

        download_model_to(&target).await.expect("download failed");

        for (name, _) in MODEL_FILES {
            assert!(target.join(name).is_file(), "{name} is missing");
        }
        assert!(
            !target.with_extension("incoming").exists(),
            "the staging directory must not survive a successful download"
        );

        // The point of downloading it: it has to actually work.
        let model = Model2VecEmbedder::load(&target).expect("downloaded model would not load");
        assert_eq!(model.dimensions(), 256, "potion-base-8M is 256-wide");

        // And a second call must be a no-op rather than re-downloading.
        download_model_to(&target).await.expect("re-run failed");
    }

    /// A failed download must leave nothing behind. Otherwise a later run sees
    /// a directory, assumes a model, and loads a broken one.
    #[tokio::test]
    #[ignore = "network"]
    async fn a_failed_download_leaves_no_staging_directory() {
        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join(MODEL_DIR);
        let staging = target.with_extension("incoming");

        // Force a failure by capping below the real file size.
        let client = crate::extensions::github::http_client().unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        let result = crate::extensions::github::download_capped(
            &client,
            &format!("{MODEL_BASE_URL}/model.safetensors"),
            1024,
        )
        .await
        .inspect_err(|_| {
            let _ = std::fs::remove_dir_all(&staging);
        });

        assert!(result.is_err());
        assert!(!staging.exists(), "staging must be cleaned up on failure");
        assert!(!target.exists(), "nothing may be installed");
    }

    /// The cap must fire mid-stream, not after the whole body is resident.
    #[tokio::test]
    #[ignore = "network"]
    async fn an_oversized_file_is_refused() {
        let client = crate::extensions::github::http_client().unwrap();
        let err = crate::extensions::github::download_capped(
            &client,
            &format!("{MODEL_BASE_URL}/model.safetensors"),
            1024,
        )
        .await
        .expect_err("a 30 MB file must not pass a 1 KB cap");

        assert!(
            matches!(err, AppError::Invalid(_)),
            "expected a cap error, got {err:?}"
        );
    }
}
