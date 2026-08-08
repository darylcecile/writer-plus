/**
 * Install-time consent for an extension's capabilities.
 *
 * The permission model is enforced in Rust, but enforcement alone is not
 * consent: a grant the user never saw is a grant they never agreed to. This is
 * the surface that makes the model honest, so it deliberately does not
 * summarise, truncate, or soften what an extension asked for.
 *
 * **The wording comes from Rust, not from here.** `PermissionDescription` is
 * derived by the same module that enforces the grant, so the sentence a user
 * reads cannot drift from what the extension is actually allowed to do. An
 * earlier version derived it in TypeScript from a separate schema, and the two
 * diverged badly enough that a real downloaded extension would have shown an
 * empty permission list.
 *
 * The `unsafe` tier is presented differently from everything else, and not for
 * decoration. Every other capability is scope-checked - `workspace.read` can
 * only reach files matching the manifest's globs, and Rust will refuse the
 * rest. `unsafe` has no scope: it starts a program that runs as the user,
 * which Writer cannot inspect, restrict, or revoke once it is running.
 * Rendering it in the same list as "Read notes" would imply a symmetry that
 * does not exist.
 */

import { useState } from "react";
import { SurfaceCard } from "../surface-card";
import type { InstallCandidate } from "./install";

interface ExtensionConsentProps {
  candidate: InstallCandidate;
  onApprove: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ExtensionConsent({
  candidate,
  onApprove,
  onCancel,
  busy = false,
}: ExtensionConsentProps) {
  const { manifest, permissions, replacesVersion, addedCapabilities } = candidate;
  const unsafe = permissions.filter((p) => p.tier === "unsafe");
  const scoped = permissions.filter((p) => p.tier !== "unsafe");

  const isUpdate = replacesVersion != null;
  // An update that asks for nothing new is applied without this dialog, so a
  // non-empty diff is the whole reason the user is being interrupted.
  const escalating = addedCapabilities.length > 0;

  // The unsafe tier requires a separate, deliberate action. A single "Install"
  // button lets a user approve arbitrary code execution with the same reflex
  // they use to dismiss a cookie banner.
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = busy || (unsafe.length > 0 && !acknowledged);

  return (
    <SurfaceCard className="extension-consent">
      <header className="extension-consent__header">
        <h2>
          {isUpdate ? "Update" : "Install"} {manifest.name}?
        </h2>
        <p className="extension-consent__author">
          {manifest.author} &middot; {candidate.repo} &middot;{" "}
          {isUpdate ? `${replacesVersion} → ${candidate.version}` : `v${candidate.version}`}
        </p>
      </header>

      {escalating && (
        <section className="extension-consent__section extension-consent__section--diff">
          <h3>This update asks for access it did not have before</h3>
          <p className="extension-consent__detail">
            The version you already trust could not do the following. Updates that add access are
            never applied automatically.
          </p>
          <ul className="extension-consent__list">
            {addedCapabilities.map((capability) => (
              <li key={capability}>
                <span className="extension-consent__label">{capability}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {scoped.length > 0 && (
        <section className="extension-consent__section">
          <h3>This extension will be able to:</h3>
          <ul className="extension-consent__list">
            {scoped.map((permission) => (
              <li key={permission.key}>
                <span className="extension-consent__label">{permission.label}</span>
                {permission.detail && (
                  <span className="extension-consent__detail">{permission.detail}</span>
                )}
                {permission.reason && (
                  <span className="extension-consent__reason">
                    &ldquo;{permission.reason}&rdquo;
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {unsafe.map((permission) => (
        <section
          key={permission.key}
          className="extension-consent__section extension-consent__section--unsafe"
        >
          <h3>{permission.label}</h3>
          <p className="extension-consent__detail">{permission.detail}</p>
          {permission.reason && (
            <p className="extension-consent__reason">
              {manifest.name} says: &ldquo;{permission.reason}&rdquo;
            </p>
          )}
          <p className="extension-consent__warning">
            Writer sandboxes extensions, but it cannot sandbox a program this one starts. Only
            continue if you trust {manifest.author}.
          </p>
          <label className="extension-consent__ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I understand this extension runs outside the sandbox
          </label>
        </section>
      ))}

      {permissions.length === 0 && (
        <p className="extension-consent__detail">
          This extension requests no special access. It can draw its own interface and nothing else.
        </p>
      )}

      <footer className="extension-consent__actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={unsafe.length > 0 ? "is-unsafe" : "is-primary"}
          disabled={blocked}
          onClick={onApprove}
        >
          {busy ? "Installing…" : isUpdate ? "Update" : "Install"}
        </button>
      </footer>
    </SurfaceCard>
  );
}
