import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clockTimingCollector } from "#test/mocks/clock-timing-collector.ts";
import type { PartialRunInput } from "./partial-run.ts";
import { resolvePartialRun } from "./partial-run.ts";

const ROOT = path.resolve("/repo/package");

function posixPath(...segments: Array<string>): string {
	return path.join(...segments).replaceAll("\\", "/");
}

function gitReplying(stdoutByCommand: Record<string, string>): PartialRunInput["seams"] {
	return {
		childProcess: { execFileSync: (_file, args) => stdoutByCommand[args.join(" ")] ?? "" },
	};
}

describe(resolvePartialRun, () => {
	it("should read the files changed since the ref in a profiled phase", () => {
		expect.assertions(2);

		const timing = clockTimingCollector();
		const profile = vi.spyOn(timing, "profile");

		const partialRun = resolvePartialRun({
			cli: { changed: "main" },
			rootDirectory: ROOT,
			seams: gitReplying({
				"diff --name-only --no-renames -z main...HEAD": "package/src/a.luau\0",
				"rev-parse --show-toplevel": `${path.dirname(ROOT)}\n`,
			}),
			timing,
		});

		expect(partialRun).toStrictEqual({
			files: [posixPath(ROOT, "src/a.luau")],
			kind: "changed",
			since: "main",
		});
		expect(profile).toHaveBeenCalledWith("readChangedFiles", expect.any(Function));
	});

	it("should resolve related files against the run root", () => {
		expect.assertions(1);

		expect(
			resolvePartialRun({
				cli: { related: ["src/a.luau"] },
				rootDirectory: ROOT,
				seams: gitReplying({}),
				timing: clockTimingCollector(),
			}),
		).toStrictEqual({ files: [path.resolve(ROOT, "src/a.luau")], kind: "related" });
	});

	it("should leave a full run without a Partial Run", () => {
		expect.assertions(1);

		expect(
			resolvePartialRun({
				cli: {},
				rootDirectory: ROOT,
				seams: gitReplying({}),
				timing: clockTimingCollector(),
			}),
		).toBeUndefined();
	});
});
