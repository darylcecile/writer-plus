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
    /// Number of floats per embedding vector.
    #[allow(dead_code)]
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

// ─── Tests ────────────────────────────────────────────────────────────────────

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
}
