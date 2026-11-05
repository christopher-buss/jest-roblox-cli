import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

const LUAU_DIRECTORY = path.join(import.meta.dirname, "../../luau");

export function readLuauModule(relativePath: string): string {
	return fs.readFileSync(path.join(LUAU_DIRECTORY, relativePath), "utf-8");
}

export function readHarness(name: string): string {
	return fs.readFileSync(path.join(import.meta.dirname, `${name}.harness.luau`), "utf-8");
}

export function inlineModule(source: string): string {
	return `(function()\n${source}\nend)()`;
}

export function inlineRequires(source: string, names: ReadonlyArray<string>): string {
	let result = source;
	for (const name of names) {
		const dependency = readLuauModule(`${name}.luau`);
		result = result.replace(`require("./${name}")`, () => inlineModule(dependency));
	}

	return result;
}

export function fillPlaceholders(
	harness: string,
	placeholders: Readonly<Record<string, string>>,
): string {
	let result = harness;
	for (const [placeholder, source] of Object.entries(placeholders)) {
		result = result.replace(placeholder, () => inlineModule(source));
	}

	return result;
}

export function spawnHarness(prefix: string, script: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});

	const scriptPath = path.join(directory, "harness.luau");
	fs.writeFileSync(scriptPath, script, "utf-8");

	return spawnLute({ args: [], scriptPath });
}
