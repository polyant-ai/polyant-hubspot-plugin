// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fields the engine mounts on `ctx` that the published SDK types do not carry
 * yet. Declared here so this plugin typechecks on its own; drop the entry once
 * the corresponding SDK release adds it.
 */
import "@polyant-ai/plugin-sdk";

declare module "@polyant-ai/plugin-sdk" {
  interface ToolContext {
    memoryScopeKey: string;
  }
}
