/**
 * Install-time consent for an extension's capabilities.
 *
 * The permission model is enforced in Rust, but enforcement alone is not
 * consent: a grant the user never saw is a grant they never agreed to. This is
 * the surface that makes the model honest, so it deliberately does not
 * summarise, truncate, or soften what an extension asked for.
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
import { describeCapabilities, type ExtensionManifest } from "@writer/extension-api/manifest";
import { SurfaceCard } from "../surface-card";

interface ExtensionConsentProps {
  manifest: ExtensionManifest;
  onApprove: () => void;
  onCancel: () => void;
}

export function ExtensionConsent({ manifest, onApprove, onCancel }: ExtensionConsentProps) {
  const permissions = describeCapabilities(manifest.capabilities);
  const unsafe = permissions.filter((p) => p.tier === "unsafe");
  const scoped = permissions.filter((p) => p.tier !== "unsafe");

  // The unsafe tier requires a separate, deliberate action. A single "Install"
  // button lets a user approve arbitrary code execution with the same reflex
  // they use to dismiss a cookie banner.
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = unsafe.length > 0 && !acknowledged;

  return (
    <SurfaceCard className="extension-consent">
      <header className="extension-consent__header">
        <h2>Install {manifest.name}?</h2>
        <p className="extension-consent__author">by {manifest.author}</p>
      </header>

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
          <p className="extension-consent__reason">
            {manifest.name} says: &ldquo;{permission.reason}&rdquo;
          </p>
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
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={unsafe.length > 0 ? "is-unsafe" : "is-primary"}
          disabled={blocked}
          onClick={onApprove}
        >
          Install
        </button>
      </footer>
    </SurfaceCard>
  );
}
