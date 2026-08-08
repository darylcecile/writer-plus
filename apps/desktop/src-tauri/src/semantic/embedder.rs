use crate::error::AppError;

/// Pluggable embedding provider.
///
/// The concrete backend is intentionally not settled at this layer:
///   - `fastembed` 5.x pulls an ~60 MB ONNX Runtime dylib that must be
///     codesigned for macOS notarization.
///   - `candle` is pure Rust (no dylib) and avoids that requirement.
///
/// Swap an implementation in behind this trait without touching the rest of
/// the pipeline. The dimensionality reported by `dimensions()` must match the
/// `float[N]` width used in the vec0 schema (currently 384).
pub trait Embedder: Send + Sync {
    /// Number of floats per embedding vector. The store's vec0 table is
    /// created at this width, so it must be stable for the life of an index.
    fn dimensions(&self) -> usize;

    /// Embed a batch of texts. Returns one vector per input string, in the
    /// same order.
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, AppError>;
}

// ─── HashEmbedder ─────────────────────────────────────────────────────────────

/// Deterministic feature-hashing bag-of-words embedder (384 dimensions).
///
/// **PLACEHOLDER — poor semantic quality.**
///
/// Each word is mapped to one dimension via FNV-1a hashing; the resulting
/// count vector is L2-normalised. The output is stable, deterministic, and
/// computable with zero external dependencies or model downloads, making it
/// suitable for wiring up and testing the full pipeline before a real model
/// is integrated.
///
/// To replace: implement [`Embedder`] for your chosen model type and pass it
/// as `Box<dyn Embedder>` to [`super::SemanticState::with_embedder`].
pub struct HashEmbedder;

impl Embedder for HashEmbedder {
    fn dimensions(&self) -> usize {
        384
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, AppError> {
        texts.iter().map(|t| embed_one(t, 384)).collect()
    }
}

fn embed_one(text: &str, dims: usize) -> Result<Vec<f32>, AppError> {
    let mut vec = vec![0.0f32; dims];
    for token in text.split_whitespace() {
        let idx = fnv1a(token.to_ascii_lowercase().as_bytes()) as usize % dims;
        vec[idx] += 1.0;
    }
    // L2-normalise so cosine distance is well-defined.
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-9 {
        for x in &mut vec {
            *x /= norm;
        }
    }
    Ok(vec)
}

/// FNV-1a 64-bit hash — deterministic across runs.
fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 14_695_981_039_346_656_037;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(1_099_511_628_211);
    }
    h
}

// ─── Model2VecEmbedder ────────────────────────────────────────────────────────

/// Real semantic embeddings from a Model2Vec static model.
///
/// ## Why this model family
///
/// The requirement that ruled out most options is macOS notarization: a
/// dynamically linked inference runtime has to be signed separately and shipped
/// alongside the binary. `fastembed` pulls an ~60 MB ONNX Runtime dylib for
/// exactly that reason. Model2Vec models are *static* embeddings - a token
/// lookup table distilled from a sentence transformer - so inference is a table
/// lookup plus a mean, and `model2vec-rs` implements it in pure Rust. Nothing
/// is dynamically linked and no runtime is shipped.
///
/// The trade is quality: static embeddings have no attention, so they cannot
/// tell "the dog bit the man" from "the man bit the dog". For finding notes on
/// a topic - the use case this index exists for - that limitation costs little,
/// while the difference against [`HashEmbedder`] is categorical rather than
/// incremental: hashing puts "car" and "automobile" in unrelated dimensions
/// because it only ever compares spellings.
///
/// ## Weights are not bundled
///
/// The model is ~29 MB and is fetched once rather than committed to the
/// repository or added to the app bundle. Until it is present the index falls
/// back to [`HashEmbedder`], which is why that type still exists.
pub struct Model2VecEmbedder {
    model: model2vec_rs::model::StaticModel,
    dimensions: usize,
}

impl Model2VecEmbedder {
    /// Load a model from a directory containing `config.json`,
    /// `model.safetensors`, and `tokenizer.json`.
    ///
    /// The dimensionality is read from the loaded model rather than assumed.
    /// Hard-coding it would mean a model swap silently produced vectors of the
    /// wrong width, and sqlite-vec would reject or mis-store them at insert
    /// time - far from the line that caused it.
    pub fn load(dir: &std::path::Path) -> Result<Self, AppError> {
        if !dir.join("model.safetensors").is_file() {
            return Err(AppError::NotFound(format!(
                "no embedding model at {}",
                dir.display()
            )));
        }

        let model = model2vec_rs::model::StaticModel::from_pretrained(dir, None, None, None)
            .map_err(|e| AppError::Invalid(format!("could not load embedding model: {e}")))?;

        // Probe rather than trust a config field: the number that matters is
        // the width this model actually emits.
        let probe = model.encode(&["dimension probe".to_string()]);
        let dimensions = probe
            .first()
            .map(Vec::len)
            .filter(|d| *d > 0)
            .ok_or_else(|| AppError::Invalid("embedding model produced no output".into()))?;

        Ok(Self { model, dimensions })
    }
}

impl Embedder for Model2VecEmbedder {
    fn dimensions(&self) -> usize {
        self.dimensions
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, AppError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut vectors = self.model.encode(texts);

        if vectors.len() != texts.len() {
            return Err(AppError::Invalid(format!(
                "embedding model returned {} vectors for {} inputs",
                vectors.len(),
                texts.len()
            )));
        }

        // The store compares with cosine distance, which is only meaningful on
        // unit vectors. Normalising here rather than trusting the model's own
        // `normalize` config keeps that guarantee a property of this type.
        for vector in &mut vectors {
            if vector.len() != self.dimensions {
                return Err(AppError::Invalid(format!(
                    "embedding model returned {} dimensions, expected {}",
                    vector.len(),
                    self.dimensions
                )));
            }
            l2_normalise(vector);
        }
        Ok(vectors)
    }
}

fn l2_normalise(vector: &mut [f32]) {
    let norm: f32 = vector.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-9 {
        for x in vector {
            *x /= norm;
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

/// Where the downloaded model lives during development. Set
/// `WRITER_EMBEDDING_MODEL` to override.
///
/// Test-only: production reads the model from the app data directory, which is
/// where [`semantic_download_model`](crate::semantic::semantic_download_model)
/// puts it.
#[cfg(test)]
pub fn dev_model_dir() -> std::path::PathBuf {
    std::env::var("WRITER_EMBEDDING_MODEL")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join(".cache/writer-models/potion-base-8M")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_embedder_returns_correct_dims() {
        let e = HashEmbedder;
        let vecs = e.embed_batch(&["hello world".to_string()]).unwrap();
        assert_eq!(vecs.len(), 1);
        assert_eq!(vecs[0].len(), 384);
    }

    #[test]
    fn hash_embedder_l2_normalised() {
        let e = HashEmbedder;
        let vecs = e.embed_batch(&["quick brown fox".to_string()]).unwrap();
        let norm: f32 = vecs[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "norm={norm}");
    }

    #[test]
    fn hash_embedder_deterministic() {
        let e = HashEmbedder;
        let a = e.embed_batch(&["same text".to_string()]).unwrap();
        let b = e.embed_batch(&["same text".to_string()]).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn hash_embedder_distinct_texts_differ() {
        let e = HashEmbedder;
        let vecs = e
            .embed_batch(&["apple fruit".to_string(), "car truck".to_string()])
            .unwrap();
        assert_ne!(vecs[0], vecs[1]);
    }

    // ─── Model2VecEmbedder ────────────────────────────────────────────────────

    use super::dev_model_dir as model_dir;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn a_missing_model_is_reported_rather_than_panicking() {
        let err = match Model2VecEmbedder::load(std::path::Path::new("/nonexistent/model")) {
            Ok(_) => panic!("loading a model that is not there must fail cleanly"),
            Err(err) => err,
        };
        assert!(format!("{err}").contains("no embedding model"), "{err}");
    }

    /// The whole reason for replacing [`HashEmbedder`]: the user's stated use
    /// case is "find notes about a topic I wrote about before", which requires
    /// matching meaning, not spelling.
    ///
    /// This asserts the *ordering* rather than an absolute score, because a
    /// threshold would be a property of one specific model checkpoint and would
    /// break on any swap for reasons unrelated to correctness.
    #[test]
    #[ignore = "requires the downloaded embedding model"]
    fn embeddings_are_semantic_not_lexical() {
        let model = Model2VecEmbedder::load(&model_dir()).unwrap();

        let texts = [
            "my thoughts on buying a car",
            "notes about purchasing an automobile",
            "sourdough bread starter maintenance",
        ]
        .map(str::to_string);
        let vectors = model.embed_batch(&texts).unwrap();

        let related = cosine(&vectors[0], &vectors[1]);
        let unrelated = cosine(&vectors[0], &vectors[2]);
        assert!(
            related > unrelated,
            "car/automobile ({related}) must beat car/sourdough ({unrelated})"
        );

        // And the point of the change: the placeholder cannot do this, because
        // the two sentences share no words. If this ever stops failing, the
        // test above has stopped proving anything.
        let hashed = HashEmbedder.embed_batch(&texts).unwrap();
        assert!(
            cosine(&hashed[0], &hashed[1]) <= cosine(&hashed[0], &hashed[2]),
            "the hash embedder was expected to miss this; it no longer does"
        );
    }

    #[test]
    #[ignore = "requires the downloaded embedding model"]
    fn vectors_are_unit_length_so_cosine_distance_is_meaningful() {
        let model = Model2VecEmbedder::load(&model_dir()).unwrap();
        let vectors = model
            .embed_batch(&["a note about gardening in spring".to_string()])
            .unwrap();
        let norm: f32 = vectors[0].iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "norm={norm}");
    }

    #[test]
    #[ignore = "requires the downloaded embedding model"]
    fn dimensions_are_read_from_the_model_not_assumed() {
        let model = Model2VecEmbedder::load(&model_dir()).unwrap();
        let vectors = model.embed_batch(&["x".to_string()]).unwrap();
        assert_eq!(vectors[0].len(), model.dimensions());
        // potion-base-8M is 256-wide, which is deliberately *not* the 384 the
        // placeholder used - so a hard-coded width would fail here.
        assert_ne!(model.dimensions(), 384);
    }

    #[test]
    #[ignore = "requires the downloaded embedding model"]
    fn an_empty_batch_does_no_work() {
        let model = Model2VecEmbedder::load(&model_dir()).unwrap();
        assert!(model.embed_batch(&[]).unwrap().is_empty());
    }
}
