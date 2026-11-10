import { spawnLute } from "@isentinel/luau-ast";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

const LUAU_DIRECTORY = path.join(import.meta.dirname, "../../luau");
const RELATIVE_REQUIRE_PATTERN = /require\("(\.\.?\/[^"]+)"\)/g;
const STUB_KEY_PATTERN = /(?:\[|==\s*)"(\.\.?\/[^"]+)"/g;

export function readLuauModule(relativePath: string): string {
	return fs.readFileSync(path.join(LUAU_DIRECTORY, relativePath), "utf-8");
}

export function readHarness(name: string): string {
	return fs.readFileSync(path.join(import.meta.dirname, `${name}.harness.luau`), "utf-8");
}

export function inlineModule(source: string): string {
	return `(function()\n${source}\nend)()`;
}

export function stubbedModules(harness: string): ReadonlySet<string> {
	return new Set(
		Array.from(harness.matchAll(STUB_KEY_PATTERN), ([, request = ""]) => {
			return path.posix.basename(request);
		}),
	);
}

export function readLuauTree(relativePath: string, stubbed: ReadonlySet<string>): string {
	const directory = path.posix.dirname(relativePath);
	return readLuauModule(relativePath).replace(
		RELATIVE_REQUIRE_PATTERN,
		(call: string, request: unknown) => {
			const target = String(request);
			if (stubbed.has(path.posix.basename(target))) {
				return call;
			}

			const dependency = path.posix.join(directory, `${target}.luau`);
			return inlineModule(readLuauTree(dependency, stubbed));
		},
	);
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
