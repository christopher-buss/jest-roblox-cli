import process from "node:process";
import { describe, it } from "vitest";

import { blockProcessStarts } from "./no-process-start.ts";

const STARTERS = [
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
	"fork",
	"spawn",
	"spawnSync",
] as const;

describe(blockProcessStarts, () => {
	it.for(STARTERS)("should make %s throw", (name, { expect }) => {
		expect.assertions(1);

		blockProcessStarts();

		expect(process.getBuiltinModule("node:child_process")[name]).toThrow(
			`Unit tests may not start a process (${name}). Pass a fake adapter`,
		);
	});
});
