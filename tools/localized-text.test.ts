// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeRequiredSecrets } from "@polyant-ai/plugin-sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modules = (dir: string, suffix: string) =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter((file) => file.endsWith(suffix)).map((file) => join(root, dir, file))
    : [];
const bilingual = (text: unknown) =>
  typeof text === "object" && text !== null &&
  typeof (text as Record<string, unknown>)["en-US"] === "string" &&
  typeof (text as Record<string, unknown>)["it-IT"] === "string";

// The admin panel and the marketplace show these to people in their language; the
// description stays the model's. A tool without them shows English model text instead.
describe("text people read", () => {
  it("gives every tool and hook a summary, and every field a label and a description, in en-US and it-IT", async () => {
    const files = [...modules("tools", ".tool.ts"), ...modules("hooks", ".hook.ts")];
    expect(files.length).toBeGreaterThan(0);
    const gaps: string[] = [];
    for (const file of files) {
      const definition = (await import(file)).default;
      if (!bilingual(definition.summary)) gaps.push(`${definition.name}: summary`);
      for (const spec of normalizeRequiredSecrets(definition.requiredSecrets)) {
        if (!bilingual(spec.label)) gaps.push(`${definition.name}: ${spec.key} label`);
        if (!bilingual(spec.description)) gaps.push(`${definition.name}: ${spec.key} description`);
      }
    }
    expect(gaps).toEqual([]);
  });
});
