import { defineConfig } from "@isentinel/jest-roblox";

import base from "./jest.config.ts";

/**
 * The fixture's config with the boot probe off.
 *
 * The probe costs one task, and a cold boot with it, on every fresh upload.
 * Proving it works is worth that once; every live run after the first would be
 * paying to watch the same script return 1. The live suite therefore keeps the
 * probe on exactly one run and points the rest here.
 */
export default defineConfig({ ...base, bootProbeTimeout: 0 });
