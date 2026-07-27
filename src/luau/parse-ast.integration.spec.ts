import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const PARSE_AST_SCRIPT = path.resolve(__dirname, "parse-ast.luau");

/**
 * Expected field names from lute's AST location output — must match LuauSpan.
 */
const EXPECTED_SPAN_KEYS = ["beginColumn", "beginLine", "endColumn", "endLine"];

function createTemporaryLuauFile(source: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), "lute-ast-test-"));
	const filePath = path.join(directory, "test.luau");
	writeFileSync(filePath, source);
	return filePath;
}

function isAstNode(value: JSONValue): value is Record<string, JSONValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one key off a parsed AST node, throwing when the shape diverges from
 * the output `parse-ast.luau` documents — the contract these tests assert.
 */
function readMember(value: JSONValue, key: string): JSONValue {
	if (!isAstNode(value)) {
		throw new Error(`Expected an AST node to read "${key}" from`);
	}

	const member = value[key];
	if (member === undefined) {
		throw new Error(`Expected AST node to carry "${key}"`);
	}

	return member;
}

/** {@link readMember} narrowed to a nested AST node. */
function readNode(value: JSONValue, key: string): Record<string, JSONValue> {
	const member = readMember(value, key);
	if (!isAstNode(member)) {
		throw new Error(`Expected "${key}" to be an AST node`);
	}

	return member;
}

/** Array counterpart of {@link readMember}. */
function readElement(value: JSONValue, index: number): JSONValue {
	if (!Array.isArray(value)) {
		throw new Error(`Expected an AST array to read index ${index} from`);
	}

	const element = value[index];
	if (element === undefined) {
		throw new Error(`Expected AST array to carry index ${index}`);
	}

	return element;
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
			windowsHide: true,
		});

		const location = readNode(JSON.parse(json), "location");
		const keys = Object.keys(location).sort();

		expect(keys).toStrictEqual(EXPECTED_SPAN_KEYS.toSorted());
	});

	it("should preserve string literal values on string AST nodes", () => {
		expect.assertions(1);

		const temporaryFile = createTemporaryLuauFile('return "hello"\n');
		onTestFinished(() => {
			rmSync(path.dirname(temporaryFile), { recursive: true });
		});

		const json = execFileSync("lute", ["run", PARSE_AST_SCRIPT, "--", temporaryFile], {
			encoding: "utf-8",
			windowsHide: true,
		});

		const statement = readElement(readMember(JSON.parse(json), "statements"), 0);
		const expression = readElement(readMember(statement, "expressions"), 0);
		const stringNode = readMember(expression, "node");

		expect(stringNode).toMatchObject({ tag: "string", text: "hello" });
	});
});
