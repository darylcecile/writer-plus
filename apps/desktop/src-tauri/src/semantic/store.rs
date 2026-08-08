use crate::error::AppError;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
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

/// Fallback width, used when the store is opened without an explicit one.
/// Matches [`super::embedder::HashEmbedder`], which is what the index falls
/// back to when no real model is present.
pub const VECTOR_DIMS: usize = 384;

/// Schema for the semantic index database.
///
/// `note_meta`   — tracks path, mtime, and a content hash per note so
///                 reindexing can skip unchanged files.
/// `chunk_seq`   — autoincrement source for synthetic chunk row-ids.
/// `vec_chunks`  — sqlite-vec vec0 virtual table.  This is a brute-force
///                 linear scan; fine up to ~100 K rows for a local notes app.
///
/// The vector width is interpolated because vec0 bakes it into the table at
/// creation time. `note_path TEXT` is a *metadata* column (filterable in
/// WHERE); `+chunk_text TEXT` is *auxiliary* (returned, not filterable).
fn schema(dims: usize) -> String {
    format!(
        "
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
    embedding  float[{dims}] distance_metric=cosine,
    note_path  TEXT,
    +chunk_text TEXT
);
"
    )
}

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
    dims: usize,
}

impl VectorStore {
    /// Open (or create) the index for vectors of `dims` floats.
    ///
    /// vec0 bakes the width into the table at creation time, so an index built
    /// for one embedder cannot hold another's vectors. When the width changes -
    /// which happens the first time a real model replaces the placeholder - the
    /// tables are dropped and rebuilt rather than left to fail at insert time,
    /// far from the cause.
    ///
    /// Discarding is safe because this database is a derived cache: every row
    /// can be recomputed from the notes, which are the actual source of truth.
    pub fn open_with_dims(db_path: &Path, dims: usize) -> Result<Self, AppError> {
        // Must run before any sqlite3_open call.
        init_sqlite_vec();

        let conn = Connection::open(db_path)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;

        let existing: Option<usize> = conn
            .query_row("SELECT value FROM index_meta WHERE key = 'dims'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|v| v.parse().ok());

        // A pre-existing database with no recorded width predates this field;
        // it was built at the old fixed size.
        let effective = existing.unwrap_or_else(|| {
            let legacy = table_exists(&conn, "vec_chunks").unwrap_or(false);
            if legacy {
                VECTOR_DIMS
            } else {
                dims
            }
        });

        if effective != dims {
            conn.execute_batch(
                "DROP TABLE IF EXISTS vec_chunks;
                 DROP TABLE IF EXISTS note_meta;
                 DROP TABLE IF EXISTS chunk_seq;",
            )?;
        }

        conn.execute_batch(&schema(dims))?;
        conn.execute(
            "INSERT INTO index_meta (key, value) VALUES ('dims', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [dims.to_string()],
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
            dims,
        })
    }

    /// The vector width this store was opened for.
    pub fn dimensions(&self) -> usize {
        self.dims
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
            dimensions: self.dimensions(),
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
                self.dims,
                "embedding dimension mismatch: expected {}, got {}",
                self.dims,
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
        // A real check rather than a `debug_assert`: in release the assertion
        // would vanish and sqlite-vec would compare against the wrong width,
        // returning plausible-looking but meaningless results. Wrong answers
        // are worse than an error.
        if query_embedding.len() != self.dims {
            return Err(AppError::Invalid(format!(
                "query vector is {} floats but this index holds {}",
                query_embedding.len(),
                self.dims
            )));
        }
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
        let store = VectorStore::open_with_dims(&dir.path().join("test.db"), VECTOR_DIMS).unwrap();
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

/// Whether a table exists, used to recognise a database written before the
/// width was recorded.
fn table_exists(conn: &Connection, name: &str) -> Result<bool, AppError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            [name],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

#[cfg(test)]
mod dimension_tests {
    use super::*;
    use tempfile::TempDir;

    /// In release builds a `debug_assert` disappears, so a wrong-width query
    /// would have reached sqlite-vec and produced meaningless-but-plausible
    /// results. Silent wrong answers are worse than a visible error.
    #[test]
    fn a_wrong_width_query_is_refused_rather_than_answered() {
        let dir = TempDir::new().unwrap();
        let store = VectorStore::open_with_dims(&dir.path().join("i.db"), 8).unwrap();

        let err = store
            .knn_search(&[0.5f32; 16], 3)
            .expect_err("a 16-float query must not be run against an 8-float index");
        assert!(matches!(err, AppError::Invalid(_)), "{err:?}");
    }

    #[test]
    fn the_recorded_width_is_the_one_the_store_was_opened_for() {
        let dir = TempDir::new().unwrap();
        let store = VectorStore::open_with_dims(&dir.path().join("i.db"), 256).unwrap();
        assert_eq!(store.dimensions(), 256);
        assert_eq!(store.status().unwrap().dimensions, 256);
    }

    #[test]
    fn reopening_at_the_same_width_keeps_the_data() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("i.db");

        let store = VectorStore::open_with_dims(&path, 8).unwrap();
        store
            .upsert_note("a.md", 1, 42, &["hello".into()], &[vec![0.5f32; 8]])
            .unwrap();
        drop(store);

        let store = VectorStore::open_with_dims(&path, 8).unwrap();
        assert_eq!(store.status().unwrap().note_count, 1, "data must survive");
    }

    /// The first real model swap changes the width from 384 to 256. vec0 bakes
    /// the width into the table, so without this the app would come up and then
    /// fail on the first insert - long after the cause.
    #[test]
    fn changing_width_rebuilds_rather_than_failing_later() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("i.db");

        let store = VectorStore::open_with_dims(&path, 8).unwrap();
        store
            .upsert_note("a.md", 1, 42, &["hello".into()], &[vec![0.5f32; 8]])
            .unwrap();
        drop(store);

        let store = VectorStore::open_with_dims(&path, 16).unwrap();
        assert_eq!(store.dimensions(), 16);
        assert_eq!(
            store.status().unwrap().note_count,
            0,
            "a width change must clear the index, which is a derived cache"
        );

        // And the rebuilt table must actually accept the new width.
        store
            .upsert_note("b.md", 1, 43, &["hi".into()], &[vec![0.25f32; 16]])
            .unwrap();
        assert_eq!(store.status().unwrap().note_count, 1);
    }

    /// A database written before the width was recorded must be treated as the
    /// old fixed size, not as whatever is being asked for now.
    #[test]
    fn a_legacy_database_without_recorded_width_is_rebuilt_when_the_width_moves() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("i.db");

        let store = VectorStore::open_with_dims(&path, VECTOR_DIMS).unwrap();
        assert_eq!(store.dimensions(), VECTOR_DIMS);
        drop(store);

        // Simulate the pre-`index_meta` layout.
        {
            init_sqlite_vec();
            let conn = Connection::open(&path).unwrap();
            conn.execute("DELETE FROM index_meta", []).unwrap();
        }

        let store = VectorStore::open_with_dims(&path, 256).unwrap();
        assert_eq!(store.dimensions(), 256);
        store
            .upsert_note("a.md", 1, 42, &["x".into()], &[vec![0.1f32; 256]])
            .unwrap();
    }
}
