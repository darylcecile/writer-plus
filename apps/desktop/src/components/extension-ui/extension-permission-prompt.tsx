/**
 * Runtime permission prompt.
 *
 * Install-time consent covers capabilities whose damage is bounded by their own
 * scope. Runtime-tier ones - modifying notes, reaching an unrestricted network -
 * are asked about at the moment they are first used, because a list read weeks
 * ago at install time is not informed consent for an action happening now.
 *
 * **Rust has already refused the call by the time this renders.** This dialog
 * does not guard anything; it collects an answer that Rust then enforces. That
 * ordering is deliberate: a check that lived here would be a check running in
 * the same renderer that hosts extension UI.
 *
 * The wording is fetched from Rust rather than written here, for the same
 * reason the install dialog does it - the sentence a user reads has to come
 * from the module that grants the permission.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SurfaceCard } from "../surface-card";
import type { PermissionChoice } from "./runtime";
import type { PermissionDescription } from "./install";

export interface PermissionRequest {
  extensionId: string;
  extensionName: string;
  permissionKey: string;
}

interface ExtensionPermissionPromptProps {
  request: PermissionRequest;
  onDecide: (choice: PermissionChoice) => void;
}

export function ExtensionPermissionPrompt({ request, onDecide }: ExtensionPermissionPromptProps) {
  const description = usePermissionDescription(request.extensionId, request.permissionKey);

  return (
    <SurfaceCard className="extension-consent">
      <header className="extension-consent__header">
        <h2>Allow {request.extensionName} to do this?</h2>
        <p className="extension-consent__author">It is trying to use this for the first time.</p>
      </header>

      <section className="extension-consent__section">
        <ul className="extension-consent__list">
          <li>
            <span className="extension-consent__label">
              {description?.label ?? request.permissionKey}
            </span>
            {description?.detail && (
              <span className="extension-consent__detail">{description.detail}</span>
            )}
            {description?.reason && (
              <span className="extension-consent__reason">
                {request.extensionName} says: &ldquo;{description.reason}&rdquo;
              </span>
            )}
          </li>
        </ul>
      </section>

      <footer className="extension-consent__actions">
        {/*
          Refusing is the leftmost and least decorated action on purpose: a
          prompt whose easiest button is "allow" is not really asking.
        */}
        <button type="button" onClick={() => onDecide("never")}>
          Don&rsquo;t allow
        </button>
        <button type="button" onClick={() => onDecide("once")}>
          Allow once
        </button>
        {/*
          No primary styling. This dialog interrupts rather than being opened
          deliberately, and "always" grants the capability permanently - so
          highlighting it would be the prompt answering its own question.
        */}
        <button type="button" onClick={() => onDecide("always")}>
          Always allow
        </button>
      </footer>
    </SurfaceCard>
  );
}

/**
 * Writer's own description of a permission.
 *
 * A failure here is not fatal: the dialog falls back to the raw permission key,
 * which is less friendly but still names what is being asked. Blocking the
 * prompt on a description fetch would strand the extension instead.
 */
function usePermissionDescription(extensionId: string, key: string) {
  const [description, setDescription] = useState<PermissionDescription | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDescription(null);

    invoke<PermissionDescription>("extension_permission_detail", { extensionId, key })
      .then((result) => {
        if (!cancelled) setDescription(result);
      })
      .catch((err: unknown) => {
        console.error("[extensions] could not describe permission", key, err);
      });

    return () => {
      cancelled = true;
    };
  }, [extensionId, key]);

  return description;
}
