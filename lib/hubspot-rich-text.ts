// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Helpers for HubSpot rich-text fields (note body, task body, email body).
 *
 * HubSpot renders these fields as HTML in its UI. Plain-text bodies with
 * `\n` newlines get collapsed onto a single line and lists / bullets show
 * without indentation or line breaks. LLM-produced bodies are typically
 * plain text, so without intervention every note/task created by an agent
 * is unreadable in HubSpot.
 *
 * This module normalises a body that may be either:
 *   - already HTML (the prompt or caller emitted `<p>`, `<br>`, `<ul>`, ...) -> pass through
 *   - plain text with `\n` newlines -> escape HTML special chars and convert
 *     newlines to `<br>` so each line keeps its own row in HubSpot
 */

/** Heuristic: does this string look like it already contains HTML markup? */
function looksLikeHtml(body: string): boolean {
  // Any `<` followed by an ASCII letter is interpreted by HubSpot as a tag
  // open. We mirror that heuristic. `1 < 2` plain text won't match.
  return /<[a-zA-Z]/.test(body);
}

/**
 * Ensure a HubSpot rich-text body renders as expected.
 *
 * - If the body already contains HTML tags, return it unchanged (caller has
 *   already produced markup and we don't double-encode it).
 * - If the body is plain text, HTML-escape `<`, `>`, `&` and convert `\n`
 *   to `<br>\n` so each line keeps its row in the HubSpot UI.
 *
 * Idempotent on already-HTML inputs.
 */
export function ensureHtmlBody(body: string): string {
  if (looksLikeHtml(body)) return body;
  return body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>\n");
}
