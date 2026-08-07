/// Maximum characters per output chunk.
const MAX_CHARS: usize = 1_000;
/// Overlap retained at the start of each successive budget-split chunk.
const OVERLAP_CHARS: usize = 150;

/// Split a markdown document into overlapping text chunks suitable for
/// embedding.
///
/// Strategy (two-pass):
///   1. Split on ATX heading boundaries (`# …`, `## …`, etc.) so each
///      section begins a new chunk.
///   2. Any section that exceeds [`MAX_CHARS`] is further split on a
///      character budget with [`OVERLAP_CHARS`] overlap, preserving context
///      across split boundaries.
///
/// Empty sections (pure whitespace) are dropped.
pub fn chunk_markdown(text: &str) -> Vec<String> {
    let sections = split_by_headings(text);
    let mut chunks = Vec::new();
    for section in sections {
        let trimmed = section.trim().to_owned();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() <= MAX_CHARS {
            chunks.push(trimmed);
        } else {
            chunks.extend(split_by_budget(&trimmed, MAX_CHARS, OVERLAP_CHARS));
        }
    }
    chunks
}

/// Splits `text` into sections separated by ATX headings.
/// The heading line is kept at the top of the new section.
fn split_by_headings(text: &str) -> Vec<String> {
    let mut sections: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        // ATX heading: starts with one or more '#' followed by a space or eol.
        let is_heading = line.starts_with('#')
            && line
                .chars()
                .next()
                .map(|_| {
                    let after = line.trim_start_matches('#');
                    after.is_empty() || after.starts_with(' ')
                })
                .unwrap_or(false);

        if is_heading && !current.trim().is_empty() {
            sections.push(current.clone());
            current.clear();
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        sections.push(current);
    }
    sections
}

/// Split `text` into chunks of at most `max_chars` with `overlap` chars of
/// context carried over from the previous chunk.
fn split_by_budget(text: &str, max_chars: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + max_chars).min(chars.len());
        chunks.push(chars[start..end].iter().collect::<String>());
        if end == chars.len() {
            break;
        }
        // Advance, keeping `overlap` chars for context.
        start = end.saturating_sub(overlap);
    }
    chunks
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn heading_doc() -> &'static str {
        "# Introduction\n\
         Some intro text.\n\
         \n\
         ## Background\n\
         Background content here.\n\
         \n\
         ## Results\n\
         Result data.\n"
    }

    #[test]
    fn splits_on_headings() {
        let chunks = chunk_markdown(heading_doc());
        assert_eq!(chunks.len(), 3, "expected 3 heading sections, got {chunks:?}");
        assert!(chunks[0].starts_with("# Introduction"));
        assert!(chunks[1].starts_with("## Background"));
        assert!(chunks[2].starts_with("## Results"));
    }

    #[test]
    fn long_section_is_split_further() {
        // Build a section that exceeds MAX_CHARS.
        let long = "# Long\n".to_owned() + &"word ".repeat(250); // ~1 250 chars
        let chunks = chunk_markdown(&long);
        assert!(
            chunks.len() >= 2,
            "long section should produce multiple chunks; got {}: {chunks:?}",
            chunks.len()
        );
        for c in &chunks {
            assert!(
                c.chars().count() <= MAX_CHARS,
                "chunk exceeds MAX_CHARS: len={}",
                c.chars().count()
            );
        }
    }

    #[test]
    fn overlap_means_chunks_share_suffix_prefix() {
        let long = "# Section\n".to_owned() + &"abcde ".repeat(200);
        let chunks = chunk_markdown(&long);
        if chunks.len() >= 2 {
            // The tail of chunk[0] should appear at the start of chunk[1].
            let end0 = chunks[0].chars().count();
            let overlap_text: String = chunks[0]
                .chars()
                .skip(end0.saturating_sub(OVERLAP_CHARS))
                .collect();
            assert!(
                chunks[1].starts_with(&overlap_text),
                "overlap mismatch; expected chunk[1] to start with last {OVERLAP_CHARS} chars of chunk[0]"
            );
        }
    }

    #[test]
    fn empty_doc_produces_no_chunks() {
        assert!(chunk_markdown("").is_empty());
        assert!(chunk_markdown("   \n  \n").is_empty());
    }

    #[test]
    fn doc_without_headings_is_one_chunk_if_short() {
        let text = "Just some plain text with no headings.\n";
        let chunks = chunk_markdown(text);
        assert_eq!(chunks.len(), 1);
    }
}
