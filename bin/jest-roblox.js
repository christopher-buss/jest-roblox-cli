#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");

if (existsSync(sourceEntry)) {
	const { register } = await import("node:module");
	register("../loaders/luau-raw.mjs", import.meta.url);
	const { main } = await import("../src/cli.ts");
	main();
} else {
	const { main } = await import("../dist/cli.mjs");
	main();
}
