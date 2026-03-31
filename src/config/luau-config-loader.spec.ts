import type { Buffer } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";

vi.mock<typeof import("node:child_process")>(import("node:child_process"));
vi.mock<typeof import("node:fs")>(import("node:fs"));

function toLiteralNode(value: unknown): Record<string, unknown> {
	const location = { beginColumn: 1, beginLine: 1, endColumn: 1, endLine: 1 };

	if (typeof value === "string") {
		return { kind: "expr", location, tag: "string", text: value };
	}

	if (typeof value === "boolean") {
		return { kind: "expr", location, tag: "boolean", value };
	}

	if (typeof value === "number") {
		return { kind: "expr", location, tag: "number", value };
	}

	if (Array.isArray(value)) {
		return {
			entries: value.map((item) => ({ kind: "list", value: toLiteralNode(item) })),
			kind: "expr",
			location,
			tag: "table",
		};
	}

	return { kind: "expr", location, tag: "nil" };
}

function makeAstJson(config: Record<string, unknown>): string {
	const entries = Object.entries(config).map(([key, value]) => {
		return { key: { text: key }, kind: "record", value: toLiteralNode(value) };
	});

	return JSON.stringify({
		kind: "stat",
		location: { beginColumn: 1, beginLine: 1, endColumn: 1, endLine: 1 },
		statements: [
			{
				expressions: [
					{
						node: {
							entries,
							kind: "expr",
							location: { beginColumn: 1, beginLine: 1, endColumn: 1, endLine: 1 },
							tag: "table",
						},
					},
				],
				kind: "stat",
				location: { beginColumn: 1, beginLine: 1, endColumn: 1, endLine: 1 },
				tag: "return",
			},
		],
		tag: "block",
	});
}

describe(loadLuauConfig, () => {
	it("should return parsed config from Lute stdout", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(cp.execFileSync).mockReturnValue(
			makeAstJson({ displayName: "test" }) as Buffer & string,
		);

		const result = loadLuauConfig("project/jest.config.luau");

		expect(result).toStrictEqual({ displayName: "test" });
	});

	it("should throw when Lute is not found on PATH (ENOENT)", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(true);

		const enoentError = Object.assign(new Error("spawn lute ENOENT"), { code: "ENOENT" });
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw enoentError;
		});

		expect(() => loadLuauConfig("jest.config.luau")).toThrowWithMessage(
			Error,
			"lute is required to load .luau config files but was not found on PATH",
		);
	});

	it("should throw with generic message when Lute fails with non-ENOENT error", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			throw new Error("exit code 1");
		});

		expect(() => loadLuauConfig("bad.luau")).toThrowWithMessage(
			Error,
			"Failed to evaluate Luau config bad.luau",
		);
	});

	it("should throw when non-Error value is thrown by Lute", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(cp.execFileSync).mockImplementation(() => {
			// eslint-disable-next-line ts/only-throw-error -- testing non-Error throw path
			throw "string error";
		});

		expect(() => loadLuauConfig("bad.luau")).toThrowWithMessage(
			Error,
			"Failed to evaluate Luau config bad.luau",
		);
	});

	it("should throw when Lute stdout is not valid JSON", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(cp.execFileSync).mockReturnValue("not json" as Buffer & string);

		expect(() => loadLuauConfig("jest.config.luau")).toThrowWithMessage(
			Error,
			"Failed to parse AST JSON from Luau config jest.config.luau",
		);
	});

	it("should throw when config returns a non-table value", () => {
		expect.assertions(1);

		const ast = JSON.stringify({
			kind: "stat",
			location: { beginColumn: 1, beginLine: 1, endColumn: 1, endLine: 1 },
			statements: [
				{
					expressions: [
						{
							node: {
								kind: "expr",
								location: {},
								tag: "string",
								text: "not a table",
							},
						},
					],
					kind: "stat",
					location: { beginColumn: 1, beginLine: 1, endColumn: 1, endLine: 1 },
					tag: "return",
				},
			],
			tag: "block",
		});

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(cp.execFileSync).mockReturnValue(ast as Buffer & string);

		expect(() => loadLuauConfig("jest.config.luau")).toThrowWithMessage(
			Error,
			"Luau config jest.config.luau must return a table",
		);
	});

	it("should reuse cached temp directory on subsequent calls", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-abc");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(cp.execFileSync).mockReturnValue(makeAstJson({ a: 1 }) as Buffer & string);

		loadLuauConfig("a.luau");
		const callsAfterFirst = vi.mocked(fs.mkdtempSync).mock.calls.length;
		loadLuauConfig("b.luau");
		const callsAfterSecond = vi.mocked(fs.mkdtempSync).mock.calls.length;

		expect(callsAfterSecond - callsAfterFirst).toBe(0);
	});

	it("should recreate temp directory when cached path no longer exists", () => {
		expect.assertions(1);

		vi.mocked(fs.mkdtempSync).mockReturnValue("/tmp/jest-roblox-luau-config-new");
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(cp.execFileSync).mockReturnValue(makeAstJson({}) as Buffer & string);

		const callsBefore = vi.mocked(fs.mkdtempSync).mock.calls.length;
		loadLuauConfig("a.luau");
		loadLuauConfig("b.luau");
		const callsAfter = vi.mocked(fs.mkdtempSync).mock.calls.length;

		expect(callsAfter - callsBefore).toBe(2);
	});
});

describe(findLuauConfigFile, () => {
	it("should return resolved path when jest.config.luau exists", () => {
		expect.assertions(1);

		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = findLuauConfigFile("packages/client", "/project");

		expect(result).toBeString();
	});

	it("should return undefined when jest.config.luau does not exist", () => {
		expect.assertions(1);

		vi.mocked(fs.existsSync).mockReturnValue(false);

		const result = findLuauConfigFile("packages/client", "/project");

		expect(result).toBeUndefined();
	});

	it("should resolve path relative to cwd", () => {
		expect.assertions(1);

		vi.mocked(fs.existsSync).mockReturnValue(true);

		const result = findLuauConfigFile("lib", "/my/project");

		expect(result).toInclude("jest.config.luau");
	});
});
