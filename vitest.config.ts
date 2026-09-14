// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tool tests stub a global fetch; run files sequentially so that shared
    // global doesn't leak across files.
    fileParallelism: false,
  },
});
