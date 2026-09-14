// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { ensureHtmlBody } from "./hubspot-rich-text.js";

describe("ensureHtmlBody", () => {
  it("passes through bodies that already contain HTML tags", () => {
    const html = "<p><strong>Lead</strong></p><ul><li>One</li></ul>";
    expect(ensureHtmlBody(html)).toBe(html);
  });

  it("passes through bodies with a single <br> tag", () => {
    expect(ensureHtmlBody("Line A<br>Line B")).toBe("Line A<br>Line B");
  });

  it("converts plain-text newlines to <br> and escapes HTML special chars", () => {
    const input = "Title\nLine A & B\n1 < 2 > 0";
    const out = ensureHtmlBody(input);
    expect(out).toBe("Title<br>\nLine A &amp; B<br>\n1 &lt; 2 &gt; 0");
  });

  it("does NOT treat a bare `<` followed by space as HTML", () => {
    // "1 < 2" is plain text — the heuristic /<[a-zA-Z]/ excludes it.
    const input = "1 < 2\nover";
    const out = ensureHtmlBody(input);
    expect(out).toBe("1 &lt; 2<br>\nover");
  });

  it("is idempotent on inputs that already contain HTML", () => {
    const html = "<p>Hello</p>";
    expect(ensureHtmlBody(ensureHtmlBody(html))).toBe(html);
  });

  it("handles an empty string", () => {
    expect(ensureHtmlBody("")).toBe("");
  });
});
