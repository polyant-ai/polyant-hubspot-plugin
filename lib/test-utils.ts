// SPDX-License-Identifier: AGPL-3.0-or-later

import { vi } from "vitest";
import type { ToolContext, ToolDefinition } from "@polyant-ai/plugin-sdk";

/** `ctx.audit` for a tool test: records calls, writes nothing. */
export function createMockAudit(): ToolContext["audit"] {
  return { log: vi.fn() } as unknown as ToolContext["audit"];
}

/**
 * Call a tool the way a test wants to: `buildTool(def, ctx).execute(input)`.
 *
 * The engine's own `buildTool` also validates the input against the JSON
 * Schema and resolves skill-env placeholders. Neither belongs to a plugin
 * test, which exercises `execute` — the guardrail on the schema itself lives
 * in the engine's strict-mode lint, applied to every registered tool at boot.
 */
export function buildTool(def: ToolDefinition, ctx: ToolContext) {
  return { execute: (input: unknown) => def.execute(input, ctx) };
}

/**
 * In-memory `ctx.artifacts`: the engine binds the real one to the
 * conversation, so a test needs only the put/take pair.
 */
export function createMockArtifacts(): ToolContext["artifacts"] {
  const entries = new Map<string, { buffer: Buffer; filename: string; mime: string }>();
  let n = 0;
  return {
    put: (payload) => {
      const id = `artifact_test_${++n}`;
      entries.set(id, payload);
      return id;
    },
    take: (handle) => {
      const entry = entries.get(handle);
      if (!entry) return null;
      entries.delete(handle);
      return entry;
    },
  };
}
