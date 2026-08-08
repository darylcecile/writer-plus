/**
 * The install flow: enter a repository, review, approve.
 *
 * This is the component that makes the permission model reachable. Everything
 * else in the extension system - the Rust gate, the manifest schema, the
 * `unsafe` tier - is inert until a user can actually be asked, and until this
 * existed the consent dialog was a component nothing rendered.
 *
 * The state machine is deliberately small and explicit rather than a set of
 * booleans, because "resolving" and "installing" are both async and both can
 * fail, and a pair of independent `isLoading` flags is exactly how a dialog
 * ends up letting someone approve an install twice.
 */

import { useCallback, useEffect, useState } from "react";
import { SurfaceCard } from "../surface-card";
import { ExtensionConsent } from "./extension-consent";
import {
  type InstallCandidate,
  cancelInstall,
  commitInstall,
  clearToken,
  hasToken,
  needsConsent,
  resolveInstall,
  saveToken,
} from "./install";

/**
 * The GitHub token control.
 *
 * The token is write-only from the frontend's point of view: it goes to the OS
 * keychain and can never be read back here. That means this control can show
 * whether a token is saved, but never what it is - which is the whole point of
 * moving it out of the WebView that also runs extension UI.
 */
function GitHubToken() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSaved(await hasToken());
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    try {
      await saveToken(draft.trim());
      // Drop the plaintext as soon as it is stored; there is no reason for the
      // WebView to keep holding it.
      setDraft("");
      setError(null);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }, [draft, refresh]);

  const forget = useCallback(async () => {
    try {
      await clearToken();
      setError(null);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }, [refresh]);

  if (saved === null) return null;

  return (
    <div className="extension-install__field">
      <span>GitHub token (only for private repositories)</span>
      {saved ? (
        <div className="extension-install__token-saved">
          <span>Saved in your keychain.</span>
          <button type="button" onClick={() => void forget()}>
            Forget
          </button>
        </div>
      ) : (
        <div className="extension-install__token-entry">
          <input
            type="password"
            value={draft}
            placeholder="Optional"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim()) void save();
            }}
          />
          <button type="button" disabled={!draft.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
      {error && <p className="extension-install__error">{error}</p>}
    </div>
  );
}

type State =
  | { phase: "idle" }
  | { phase: "resolving" }
  | { phase: "reviewing"; candidate: InstallCandidate }
  | { phase: "installing"; candidate: InstallCandidate }
  | { phase: "done"; candidate: InstallCandidate }
  | { phase: "failed"; message: string };

interface InstallExtensionProps {
  onInstalled?: (extensionId: string) => void;
  /**
   * A repository to load, set from outside (the official list, or an available
   * update). Routed through this component rather than given its own install
   * path so every install - typed, official, or an update - goes through one
   * state machine and one consent dialog. A second path is where a consent bug
   * would hide.
   */
  requestedRepo?: { repo: string; nonce: number } | null;
}

export function InstallExtension({ onInstalled, requestedRepo }: InstallExtensionProps) {
  const [repo, setRepo] = useState("");
  const [state, setState] = useState<State>({ phase: "idle" });

  const install = useCallback(
    async (candidate: InstallCandidate) => {
      setState({ phase: "installing", candidate });
      try {
        await commitInstall(candidate);
        setState({ phase: "done", candidate });
        onInstalled?.(candidate.manifest.id);
      } catch (error) {
        setState({ phase: "failed", message: messageOf(error) });
      }
    },
    [onInstalled],
  );

  const resolveRepo = useCallback(
    async (target: string) => {
      if (!target.trim()) return;
      setState({ phase: "resolving" });
      try {
        const candidate = await resolveInstall(target.trim());
        if (needsConsent(candidate)) {
          setState({ phase: "reviewing", candidate });
        } else {
          // A same-permissions update. Interrupting for it would teach users to
          // dismiss consent dialogs without reading them, which is the failure
          // mode the dialog exists to avoid.
          await install(candidate);
        }
      } catch (error) {
        setState({ phase: "failed", message: messageOf(error) });
      }
    },
    [install],
  );

  const resolve = useCallback(() => resolveRepo(repo), [repo, resolveRepo]);

  // An outside request (official list, or an available update) fills the field
  // and loads it, so the user sees which repository they are about to install
  // from rather than a dialog appearing out of nowhere.
  useEffect(() => {
    if (!requestedRepo) return;
    setRepo(requestedRepo.repo);
    void resolveRepo(requestedRepo.repo);
    // `nonce` is what makes re-requesting the same repo work; `resolveRepo` is
    // stable and including it would re-fire on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedRepo?.nonce]);

  const cancel = useCallback((candidate: InstallCandidate) => {
    // Fire-and-forget: the staged bytes are only in memory, so failing to
    // cancel costs nothing worse than holding them until quit.
    void cancelInstall(candidate).catch(() => {});
    setState({ phase: "idle" });
  }, []);

  if (state.phase === "reviewing" || state.phase === "installing") {
    return (
      <ExtensionConsent
        candidate={state.candidate}
        busy={state.phase === "installing"}
        onApprove={() => void install(state.candidate)}
        onCancel={() => cancel(state.candidate)}
      />
    );
  }

  return (
    <SurfaceCard className="extension-install">
      <h2>Install an extension</h2>
      <p className="extension-install__hint">
        Extensions are installed from GitHub releases. Enter the repository that publishes one.
      </p>

      <label className="extension-install__field">
        <span>Repository</span>
        <input
          type="text"
          value={repo}
          placeholder="owner/repo"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => setRepo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void resolve();
          }}
        />
      </label>

      <GitHubToken />

      {state.phase === "failed" && <p className="extension-install__error">{state.message}</p>}
      {state.phase === "done" && (
        <p className="extension-install__ok">
          {state.candidate.manifest.name} {state.candidate.version} is installed.
        </p>
      )}

      <footer className="extension-install__actions">
        <button
          type="button"
          className="is-primary"
          disabled={state.phase === "resolving" || !repo.trim()}
          onClick={() => void resolve()}
        >
          {state.phase === "resolving" ? "Checking…" : "Continue"}
        </button>
      </footer>
    </SurfaceCard>
  );
}

/**
 * Tauri rejects commands with the serialized `AppError` string, so the error
 * reaching here is usually already the sentence we want to show. Falling back
 * to `String(error)` rather than a generic "Something went wrong" keeps the
 * actionable part - "you do not have access to that repository" - visible.
 */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
