/**
 * The Semantic Search section of Preferences.
 *
 * Exists because the embedding model is not bundled. Without a surface that
 * says so, a user gets keyword-quality results from something labelled
 * "semantic search" and has no way to discover why - which is worse than the
 * feature being absent, since a silent downgrade reads as the feature being
 * bad rather than switched off.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ModelStatus {
  /** Weights are on disk. */
  installed: boolean;
  /** Weights are on disk *and* loaded into the running process. */
  active: boolean;
}

/** Approximate download size, stated up front rather than after the fact. */
const MODEL_SIZE = "31 MB";

export function SemanticSection() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<ModelStatus>("semantic_model_status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const download = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      await invoke("semantic_download_model");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, [refresh]);

  if (!status) return null;

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">Semantic search</h2>

      <div className="-mx-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">Embedding model</p>
            <p className="text-[12px] text-[var(--text-muted)]">
              {status.active
                ? "Active. Searches match on meaning, so a note about \u201Ccars\u201D can be found by searching \u201Cautomobiles\u201D."
                : status.installed
                  ? "Downloaded. Restart Writer to start using it."
                  : `Not installed. Search currently matches words literally. The model is ${MODEL_SIZE} and runs entirely on this machine.`}
            </p>
          </div>

          {!status.installed && (
            <button
              type="button"
              disabled={downloading}
              className="shrink-0 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
              onClick={() => void download()}
            >
              {downloading ? "Downloading\u2026" : "Download"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-[12px] text-[#d9534f]">{error}</p>}
    </section>
  );
}
