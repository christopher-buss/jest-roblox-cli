import * as path from "node:path";
import process from "node:process";

import type { CoverageManifest, ReadManifestResult } from "./manifest.ts";
import { readManifest } from "./manifest.ts";

type ManifestFailure = Exclude<ReadManifestResult, { kind: "ok" }>;

/**
 * Load the coverage manifest a previous `jest-roblox instrument` run wrote
 * under `<rootDir>/.jest-roblox/coverage/`. Every failure mode degrades to
 * `undefined` — the run continues without coverage mapping — but each one
 * that is recoverable by re-instrumenting says so on stderr first. A missing
 * manifest is silent: that is the ordinary "coverage was never instrumented"
 * case, not a fault.
 */
export function loadCoverageManifest(rootDirectory: string): CoverageManifest | undefined {
	const manifestPath = path.join(
		rootDirectory,
		".jest-roblox",
		"coverage",
		"coverage-manifest.json",
	);
	const result = readManifest(manifestPath);
	if (result.kind === "ok") {
		return result.manifest;
	}

	const warning = describeManifestFailure(result);
	if (warning !== undefined) {
		process.stderr.write(warning);
	}

	return undefined;
}

function describeManifestFailure(failure: ManifestFailure): string | undefined {
	switch (failure.kind) {
		case "invalid": {
			return `Warning: Coverage manifest is invalid (re-run \`jest-roblox instrument\`): ${failure.summary}\n`;
		}
		case "malformed-json": {
			return "Warning: Coverage manifest is malformed JSON (re-run `jest-roblox instrument`)\n";
		}
		case "missing": {
			return undefined;
		}
		case "version-mismatch": {
			return `Warning: Coverage manifest version ${String(failure.actual)} does not match expected ${failure.expected} (re-run \`jest-roblox instrument\`)\n`;
		}
	}
}
