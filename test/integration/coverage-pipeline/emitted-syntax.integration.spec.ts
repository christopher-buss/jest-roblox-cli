import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { readCoverageMap } from "../../../src/coverage-pipeline/coverage-map.ts";
import { instrumentRoot } from "../../../src/coverage-pipeline/instrumenter.ts";

const PARSE_AST_SCRIPT = path.resolve(__dirname, "../../../src/luau/parse-ast.luau");

interface InstrumentedSource {
	/** Arm count per branch, in the order the collector recorded them. */
	branchArmCounts: Array<number>;
	instrumented: string;
	/** The parse error `lute` reports for the instrumented twin, if any. */
	parseFailure: string | undefined;
}

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return directory;
}

/**
 * Parses a file with the same Luau parser the runtime compiles with, returning
 * the parser's complaint when it refuses the source. A `loadstring` compile
 * failure in Roblox is this same parse failure — instrumented output that does
 * not parse here cannot be loaded there.
 */
function parseFile(filePath: string): string | undefined {
	try {
		execFileSync("lute", ["run", PARSE_AST_SCRIPT, "--", filePath], {
			encoding: "utf-8",
			// The AST print is large and unread; only stderr matters here.
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});

		return undefined;
	} catch (err) {
		if (err instanceof Error && "stderr" in err && typeof err.stderr === "string") {
			return err.stderr;
		}

		return err instanceof Error ? err.message : "lute failed";
	}
}

/** Instruments one source file through the real lute-backed pipeline. */
function instrumentSource(source: string): InstrumentedSource {
	const luauRoot = createTemporaryDirectory("jest-roblox-emitted-src-");
	const shadowDirectory = createTemporaryDirectory("jest-roblox-emitted-shadow-");
	writeFileSync(path.join(luauRoot, "module.luau"), source);

	const files = instrumentRoot({ luauRoot, shadowDir: shadowDirectory });
	const record = Object.values(files)[0]!;

	const coverageMap = readCoverageMap(record.coverageMapPath);
	assert(coverageMap.kind === "ok", "expected a coverage map sidecar");

	const branches = coverageMap.map.branchMap ?? {};

	return {
		branchArmCounts: Object.values(branches).map((branch) => branch.locations.length),
		instrumented: readFileSync(record.instrumentedLuauPath, "utf-8"),
		parseFailure: parseFile(record.instrumentedLuauPath),
	};
}

describe("instrumented luau syntax", () => {
	it("should emit parseable luau for an else body holding only a comment", () => {
		expect.assertions(2);

		const result = instrumentSource(
			[
				"local value = 1",
				"if value == 1 then",
				'\tprint("one")',
				"else",
				"\t-- // nothing to do here",
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([2]);
	});

	it("should emit parseable luau for an if/elseif chain ending in a comment-only else", () => {
		expect.assertions(2);

		const result = instrumentSource(
			[
				"local value = 1",
				"if value == 1 then",
				'\tprint("one")',
				"elseif value == 2 then",
				'\tprint("two")',
				"elseif value == 3 then",
				'\tprint("three")',
				"else",
				"\t-- // The remaining values are not valid",
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([4]);
	});

	it("should emit parseable luau for an else body with nothing in it", () => {
		expect.assertions(2);

		const result = instrumentSource(
			["local value = 1", "if value == 1 then", '\tprint("one")', "else", "end", ""].join(
				"\n",
			),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([2]);
	});

	it("should emit parseable luau for empty function and loop bodies", () => {
		expect.assertions(1);

		const result = instrumentSource(
			[
				"local function noop()",
				"end",
				"while noop() do",
				"end",
				"for index = 1, 2 do",
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
	});

	it("should keep the arm counter inside an else body that has statements", () => {
		expect.assertions(4);

		const result = instrumentSource(
			[
				"local value = 1",
				"if value == 1 then",
				'\tprint("one")',
				"else",
				'\tprint("other")',
				"end",
				"",
			].join("\n"),
		);

		expect(result.parseFailure).toBeUndefined();
		expect(result.branchArmCounts).toStrictEqual([2]);
		expect(result.instrumented).toContain(
			'__cov_b[1][2] += 1; __cov_s[4] += 1; print("other")',
		);
		// The synthesized arm belongs to an `if` with no `else` at all; emitting
		// it beside a real `else` is what produced two `else` keywords.
		expect(result.instrumented).not.toContain("else __cov_b");
	});
});
