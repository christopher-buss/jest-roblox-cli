import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const PARSE_AST_SCRIPT = path.resolve(__dirname, "parse-ast.luau");

/** Expected field names from lute's AST location output — must match LuauSpan. */
const EXPECTED_SPAN_KEYS = ["beginColumn", "beginLine", "endColumn", "endLine"];

function createTemporaryLuauFile(source: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), "lute-ast-test-"));
	const filePath = path.join(directory, "test.luau");
	writeFileSync(filePath, source);
	return filePath;
}

describe("parse-ast.luau lute integration", () => {
	it("should produce AST location fields matching LuauSpan", () => {
		expect.assertions(1);

		const temporaryFile = createTemporaryLuauFile("local x = 1\n");
		onTestFinished(() => {
			rmSync(path.dirname(temporaryFile), { recursive: true });
		});

		const json = execFileSync("lute", ["run", PARSE_AST_SCRIPT, "--", temporaryFile], {
			encoding: "utf-8",
		});

		const ast = JSON.parse(json) as { location: Record<string, unknown> };
		const keys = Object.keys(ast.location).sort();

		expect(keys).toStrictEqual([...EXPECTED_SPAN_KEYS].sort());
	});
});
