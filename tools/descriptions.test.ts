// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * The model reads a tool's description and parameter descriptions as
 * instructions, so a name in them has to be one it was given. Engine 1.2.0
 * renamed the tools extracted into plugins (the engine's
 * `*_rename_extracted_tools.sql` migration, e.g. `hubspotNote` → `hubspot:note`)
 * and equips a plugin tool as `<namespace>__<name>`, because providers reject
 * `:` in a tool name. "Use hubspotNote" now names a tool that does not exist.
 */
const RETIRED_FLAT_NAMES = [
  "hubspotContact", "hubspotCreateTask", "hubspotDeal", "hubspotFile", "hubspotGetCompany",
  "hubspotMeeting", "hubspotNote", "hubspotSendEmail", "hubspotTicket",
  "markdownToPdf", "ghIssue", "ghPR", "gitCloneRepo", "renderService",
];

const files = readdirSync(new URL(".", import.meta.url)).filter((file) => file.endsWith(".tool.ts"));

describe("tool descriptions", () => {
  it.each(files)("%s names other tools only as the model sees them", async (file) => {
    const tool = (await import(`./${file}`)).default as { description: string; inputSchema: unknown };
    const text = `${tool.description}\n${JSON.stringify(tool.inputSchema)}`;
    for (const name of RETIRED_FLAT_NAMES) {
      // `extra__markdownToPdf` is the model-facing name and is fine; a bare or
      // colon-prefixed `markdownToPdf` is not.
      expect(text).not.toMatch(new RegExp(`(^|[^_])\\b${name}\\b`));
    }
    expect(text).not.toMatch(/\b(hubspot|extra|github|render):[a-zA-Z]+/);
  });
});
