use crate::error::AppError;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Once;

// ─── sqlite-vec bootstrap ─────────────────────────────────────────────────────

static INIT_VEC: Once = Once::new();

/// Register the sqlite-vec extension PROCESS-GLOBALLY, exactly once, before
/// the first connection is opened.
///
/// `sqlite3_auto_extension` is a SQLite C API that schedules an entry-point
/// to run inside every subsequent `sqlite3_open*` call.  We transmute the
/// function pointer to satisfy Rust's type system: sqlite-vec declares it as
/// `extern "C" fn()` for registration purposes, but the actual ABI places the
/// standard three extension-init args in registers/stack as usual.  This is
/// the canonical pattern endorsed by the sqlite-vec project.
fn init_sqlite_vec() {
    INIT_VEC.call_once(|| {
        #[allow(clippy::missing_transmute_annotations)]
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

// ─── Schema ───────────────────────────────────────────────────────────────────

/// Number of float dimensions for stored vectors.  Must match the `Embedder`
/// in use.  The vec0 virtual table bakes this into the schema at creation
/// time; changing it requires dropping and recreating the table.
pub const VECTOR_DIMS: usize = 384;

/// Schema for the semantic index database.
///
/// `note_meta`   — tracks path, mtime, and a content hash per note so
///                 reindexing can skip unchanged files.
/// `chunk_seq`   — autoincrement source for synthetic chunk row-ids.
/// `vec_chunks`  — sqlite-vec vec0 virtual table.  This is a brute-force
///                 linear scan; fine up to ~100 K rows for a local notes app.
///
/// Vector type: `float[384] distance_metric=cosine`.
/// `note_path TEXT`  is a *metadata* column (filterable in WHERE).
/// `+chunk_text TEXT` is an *auxiliary* column (returned in SELECT, not filterable).
const SCHEMA: &str = "
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS note_meta (
    path         TEXT    PRIMARY KEY,
    mtime        INTEGER NOT NULL,
    content_hash INTEGER NOT NULL,
    chunk_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunk_seq (
    id INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    chunk_id   INTEGER PRIMARY KEY,
    embedding  float[384] distance_metric=cosine,
    note_path  TEXT,
    +chunk_text TEXT
);
";

// ─── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct IndexStatus {
    pub note_count: usize,
    pub chunk_count: usize,
    pub dimensions: usize,
}

#[derive(Debug)]
pub struct SearchHit {
    pub note_path: String,
    pub chunk_text: String,
    pub distance: f64,
}

// ─── VectorStore ──────────────────────────────────────────────────────────────

/// sqlite-vec backed persistent vector store.
///
/// A single `Mutex<Connection>` serialises all access.  `parking_lot::Mutex`
/// is used to keep the lock type consistent with the rest of the codebase and
/// to avoid poisoning on panics.
pub struct VectorStore {
    conn: Mutex<Connection>,
}

impl VectorStore {
    /// Open (or create) the semantic index database at `db_path`.
    /// Applies the schema and enables WAL mode.
    pub fn open(db_path: &Path) -> Result<Self, AppError> {
        // Must run before any sqlite3_open call.
        init_sqlite_vec();

        let conn = Connection::open(db_path)?;
        conn.execute_batch(SCHEMA)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    /// Return aggregate counts for the status command.
    pub fn status(&self) -> Result<IndexStatus, AppError> {
        let conn = self.conn.lock();
        let note_count: i64 = conn.query_row("SELECT COUNT(*) FROM note_meta", [], |r| r.get(0))?;
        let chunk_count: i64 = conn.query_row(
            "SELECT COALESCE(SUM(chunk_count), 0) FROM note_meta",
            [],
            |r| r.get(0),
        )?;
        Ok(IndexStatus {
            note_count: note_count as usize,
            chunk_count: chunk_count as usize,
            dimensions: VECTOR_DIMS,
        })
    }

    /// `true` if the stored mtime + content hash match, meaning no reindex is
    /// necessary.
    pub fn is_unchanged(&self, path: &str, mtime: u64, hash: u64) -> Result<bool, AppError> {
        let conn = self.conn.lock();
        match conn.query_row(
            "SELECT mtime, content_hash FROM note_meta WHERE path = ?1",
            params![path],
            |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
        ) {
            Ok((stored_mtime, stored_hash)) => Ok(stored_mtime == mtime && stored_hash == hash),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(AppError::Database(e.to_string())),
        }
    }

    /// All note paths currently tracked in the store.
    pub fn known_paths(&self) -> Result<Vec<String>, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path FROM note_meta")?;
        let paths = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(paths)
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    /// Replace all chunks for `path` with the provided chunks+embeddings, and
    /// update the change-detection metadata.
    ///
    /// # Panics (debug only)
    /// Panics if `chunks.len() != embeddings.len()` or if any embedding
    /// has the wrong dimension.
    pub fn upsert_note(
        &self,
        path: &str,
        mtime: u64,
        hash: u64,
        chunks: &[String],
        embeddings: &[Vec<f32>],
    ) -> Result<(), AppError> {
        debug_assert_eq!(chunks.len(), embeddings.len());
        for e in embeddings {
            debug_assert_eq!(
                e.len(),
                VECTOR_DIMS,
                "embedding dimension mismatch: expected {VECTOR_DIMS}, got {}",
                e.len()
            );
        }

        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // Remove stale data for this path.
        tx.execute("DELETE FROM vec_chunks WHERE note_path = ?1", params![path])?;
        tx.execute("DELETE FROM note_meta WHERE path = ?1", params![path])?;

        // Insert new chunks.
        for (chunk_text, embedding) in chunks.iter().zip(embeddings.iter()) {
            // Allocate a fresh autoincrement id for the chunk row.
            tx.execute("INSERT INTO chunk_seq DEFAULT VALUES", [])?;
            let chunk_id = tx.last_insert_rowid();
            let blob = floats_to_blob(embedding);
            tx.execute(
                "INSERT INTO vec_chunks(chunk_id, embedding, note_path, chunk_text) \
                 VALUES(?1, ?2, ?3, ?4)",
                params![chunk_id, blob.as_slice(), path, chunk_text],
            )?;
        }

        // Record updated metadata.
        tx.execute(
            "INSERT OR REPLACE INTO note_meta(path, mtime, content_hash, chunk_count) \
             VALUES(?1, ?2, ?3, ?4)",
            params![path, mtime as i64, hash as i64, chunks.len() as i64],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Delete all chunks and metadata for `path`.
    pub fn remove_note(&self, path: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM vec_chunks WHERE note_path = ?1", params![path])?;
        conn.execute("DELETE FROM note_meta WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn clear_all(&self) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM vec_chunks", [])?;
        conn.execute("DELETE FROM note_meta", [])?;
        conn.execute("DELETE FROM chunk_seq", [])?;
        Ok(())
    }

    // ── Search ────────────────────────────────────────────────────────────────

    /// Return the `limit` nearest chunks to `query_embedding`, ordered by
    /// cosine distance (ascending — smaller is closer).
    ///
    /// The `k = ?` constraint is required by sqlite-vec's vec0 implementation
    /// to drive the KNN scan.
    pub fn knn_search(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<SearchHit>, AppError> {
        debug_assert_eq!(
            query_embedding.len(),
            VECTOR_DIMS,
            "query dimension mismatch"
        );
        let blob = floats_to_blob(query_embedding);
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT note_path, chunk_text, distance \
             FROM vec_chunks \
             WHERE embedding MATCH ?1 AND k = ?2 \
             ORDER BY distance",
        )?;
        let hits = stmt
            .query_map(params![blob.as_slice(), limit as i64], |r| {
                Ok(SearchHit {
                    note_path: r.get(0)?,
                    chunk_text: r.get(1)?,
                    distance: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(hits)
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Serialise a float slice as raw little-endian bytes — the format sqlite-vec
/// expects for BLOB-encoded vectors.  Much faster than the JSON text form.
pub fn floats_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// FNV-1a 64-bit hash used to detect content changes without a crypto crate.
pub fn content_hash(data: &[u8]) -> u64 {
    let mut h: u64 = 14_695_981_039_346_656_037;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(1_099_511_628_211);
    }
    h
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open_test_store() -> (VectorStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = VectorStore::open(&dir.path().join("test.db")).unwrap();
        (store, dir)
    }

    /// Build a 384-dim vector with a single active dimension.
    fn unit_vec(active_dim: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; VECTOR_DIMS];
        v[active_dim] = 1.0;
        v
    }

    // ── Round-trip ────────────────────────────────────────────────────────────

    #[test]
    fn round_trip_stores_and_retrieves_chunk() {
        let (store, _dir) = open_test_store();
        let embedding = unit_vec(0);
        store
            .upsert_note(
                "note.md",
                1_000,
                42,
                &["Hello world".to_string()],
                std::slice::from_ref(&embedding),
            )
            .unwrap();

        // A KNN search with the same vector should return the stored chunk.
        let hits = store.knn_search(&embedding, 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_path, "note.md");
        assert_eq!(hits[0].chunk_text, "Hello world");
        // Cosine distance of identical vectors is 0.
        assert!(hits[0].distance < 1e-4, "distance={}", hits[0].distance);
    }

    // ── KNN ordering ─────────────────────────────────────────────────────────

    #[test]
    fn knn_returns_nearest_chunk_first() {
        let (store, _dir) = open_test_store();

        // A: only dim 0 active — closest to query
        store
            .upsert_note("a.md", 1, 1, &["chunk a".to_string()], &[unit_vec(0)])
            .unwrap();
        // B: only dim 1 active — orthogonal to query (cosine distance = 1)
        store
            .upsert_note("b.md", 2, 2, &["chunk b".to_string()], &[unit_vec(1)])
            .unwrap();

        let query = unit_vec(0); // same direction as A
        let hits = store.knn_search(&query, 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].note_path, "a.md", "nearest chunk should be a.md");
        assert!(
            hits[0].distance < hits[1].distance,
            "distances should be ordered ascending: {} >= {}",
            hits[0].distance,
            hits[1].distance
        );
    }

    // ── Skip unchanged ────────────────────────────────────────────────────────

    #[test]
    fn is_unchanged_true_when_mtime_and_hash_match() {
        let (store, _dir) = open_test_store();
        store
            .upsert_note("n.md", 9_000, 777, &["text".to_string()], &[unit_vec(2)])
            .unwrap();
        assert!(store.is_unchanged("n.md", 9_000, 777).unwrap());
        // Different mtime
        assert!(!store.is_unchanged("n.md", 9_001, 777).unwrap());
        // Different hash
        assert!(!store.is_unchanged("n.md", 9_000, 778).unwrap());
        // Unknown path
        assert!(!store.is_unchanged("unknown.md", 9_000, 777).unwrap());
    }

    // ── Remove note ───────────────────────────────────────────────────────────

    #[test]
    fn remove_note_deletes_all_its_chunks() {
        let (store, _dir) = open_test_store();
        store
            .upsert_note(
                "del.md",
                1,
                1,
                &["chunk one".to_string(), "chunk two".to_string()],
                &[unit_vec(0), unit_vec(1)],
            )
            .unwrap();

        // Before removal: status shows the note and chunks
        let before = store.status().unwrap();
        assert_eq!(before.note_count, 1);
        assert_eq!(before.chunk_count, 2);

        store.remove_note("del.md").unwrap();

        let after = store.status().unwrap();
        assert_eq!(after.note_count, 0);
        assert_eq!(after.chunk_count, 0);

        // KNN search returns nothing.
        let hits = store.knn_search(&unit_vec(0), 10).unwrap();
        assert!(hits.is_empty());
    }

    // ── known_paths ───────────────────────────────────────────────────────────

    #[test]
    fn known_paths_reflects_store_contents() {
        let (store, _dir) = open_test_store();
        assert!(store.known_paths().unwrap().is_empty());
        store
            .upsert_note("a.md", 1, 1, &["a".to_string()], &[unit_vec(0)])
            .unwrap();
        store
            .upsert_note("b.md", 2, 2, &["b".to_string()], &[unit_vec(1)])
            .unwrap();
        let mut paths = store.known_paths().unwrap();
        paths.sort();
        assert_eq!(paths, vec!["a.md", "b.md"]);
    }

    // ── content_hash ─────────────────────────────────────────────────────────

    #[test]
    fn content_hash_same_input_same_output() {
        let a = content_hash(b"hello");
        let b = content_hash(b"hello");
        assert_eq!(a, b);
    }

    #[test]
    fn content_hash_different_inputs_differ() {
        assert_ne!(content_hash(b"hello"), content_hash(b"world"));
    }
}
