// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Truncate a string before it goes into an audit detail field. Copied from the
 * engine rather than imported: a plugin compiles on its own, and the audit
 * contract it uses is `ctx.audit.log()`, not the engine's logger module.
 */
export function auditPreview(text: string, maxLen = 100): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
