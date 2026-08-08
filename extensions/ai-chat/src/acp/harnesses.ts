/**
 * Known ACP agent harnesses.
 *
 * This list lives in the extension, not the host. Writer has no opinion about
 * AI vendors, and baking a preset table into the app would mean shipping a new
 * Writer release every time a harness renames a flag. An extension can be
 * updated on its own cadence.
 *
 * The list is deliberately closed rather than "type any command you like".
 * `process.spawn` is already the unsafe tier, but a fixed set of well-known
 * tools is still a meaningfully smaller target than a free-text command box in
 * the preferences UI, which is a standing invitation for a malicious note or a
 * copy-pasted "fix" to turn into arbitrary execution.
 *
 * Every invocation below was verified against the real tool or registry rather
 * than recalled:
 *   - `copilot --acp`            — `copilot --help`, CLI 1.0.78, run locally
 *   - `gemini --experimental-acp` — https://github.com/google-gemini/gemini-cli
 *   - `@agentclientprotocol/claude-agent-acp` — npm registry, version pinned
 *   - `@agentclientprotocol/codex-acp`        — npm registry, version pinned
 *
 * npx versions are pinned on purpose. `@latest` is a network fetch at spawn
 * time and hands whoever controls the package the ability to change what runs
 * on the user's machine between one launch and the next.
 */

export interface Harness {
  id: string;
  /** Shown in the harness picker. */
  name: string;
  /** Program to resolve on PATH. */
  program: string;
  args: string[];
  /** Shown when the program is not installed. */
  install: string;
}

export const HARNESSES: Harness[] = [
  {
    id: "copilot",
    name: "GitHub Copilot",
    program: "copilot",
    args: ["--acp"],
    install: "npm i -g @github/copilot, then run `copilot login`",
  },
  {
    id: "claude",
    name: "Claude Code",
    program: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.66.0"],
    install: "Install Claude Code and sign in: https://claude.ai/code",
  },
  {
    id: "codex",
    name: "Codex",
    program: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.14"],
    install: "Install the Codex CLI and sign in",
  },
  {
    id: "gemini",
    name: "Gemini",
    program: "gemini",
    args: ["--experimental-acp"],
    install: "npm i -g @google/gemini-cli, then run `gemini` once to sign in",
  },
];

export function findHarness(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}
