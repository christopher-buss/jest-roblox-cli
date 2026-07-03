#!/usr/bin/env node
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load, resolve as resolveLuau } from "../loaders/luau-raw.mjs";

const sourceEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

registerHooks({ load, resolve: resolveLuau });

const { main } = existsSync(sourceEntry)
	? await import("../src/cli.ts")
	: await import("../dist/cli.mjs");
await main();
