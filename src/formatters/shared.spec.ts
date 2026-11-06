import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import type { SourceMapper } from "../source-mapper/index.ts";
import { getTerminalWidth, makeRelative, resolveDisplayPath, withPackageRoot } from "./shared.ts";

function setColumns(columns: number | undefined): void {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
	onTestFinished(() => {
		if (descriptor === undefined) {
			Reflect.deleteProperty(process.stdout, "columns");
		} else {
			Object.defineProperty(process.stdout, "columns", descriptor);
		}
	});
}

describe(resolveDisplayPath, () => {
	it("should return the test file path without a source mapper", () => {
		expect.assertions(1);

		expect(resolveDisplayPath("out/a.spec.luau", { rootDir: "/repo" })).toBe("out/a.spec.luau");
	});

	it("should use the source mapper's display path when it has one", () => {
		expect.assertions(1);

		const sourceMapper = fromPartial<SourceMapper>({
			resolveDisplayPath: () => "src/a.spec.ts",
		});

		expect(resolveDisplayPath("out/a.spec.luau", { rootDir: "/repo", sourceMapper })).toBe(
			"src/a.spec.ts",
		);
	});
});

describe("resolveDisplayPath under the run root", () => {
	it("should show an absolute test file path relative to the run root", () => {
		expect.assertions(1);

		expect(resolveDisplayPath("/repo/modules/app/src/a.spec.luau", { rootDir: "/repo" })).toBe(
			"modules/app/src/a.spec.luau",
		);
	});
});

describe(makeRelative, () => {
	it("should shorten a path under the root", () => {
		expect.assertions(1);

		expect(makeRelative("/repo/modules/app/src/a.spec.luau", "/repo")).toBe(
			"modules/app/src/a.spec.luau",
		);
	});

	it("should leave a path in a sibling that shares the root's prefix", () => {
		expect.assertions(1);

		expect(makeRelative("/repo-two/src/a.spec.luau", "/repo")).toBe(
			"/repo-two/src/a.spec.luau",
		);
	});

	it("should leave a relative path unchanged", () => {
		expect.assertions(1);

		expect(makeRelative("src/a.spec.luau", "/repo")).toBe("src/a.spec.luau");
	});

	it("should shorten a drive-less path under a root with a drive letter", () => {
		expect.assertions(1);

		expect(makeRelative("/roblox/modules/x.spec.luau", "D:/roblox")).toBe(
			"modules/x.spec.luau",
		);
	});

	it("should match a Windows path against a root spelled with backslashes", () => {
		expect.assertions(1);

		expect(makeRelative("D:/repo/src/a.spec.luau", "D:\\repo\\")).toBe("src/a.spec.luau");
	});
});

describe(getTerminalWidth, () => {
	it("should read the stdout column count", () => {
		expect.assertions(1);

		setColumns(120);

		expect(getTerminalWidth()).toBe(120);
	});

	it("should default to 80 columns when stdout reports none", () => {
		expect.assertions(1);

		setColumns(0);

		expect(getTerminalWidth()).toBe(80);
	});
});

describe(withPackageRoot, () => {
	it("should keep the run root when the project has no package root", () => {
		expect.assertions(1);

		expect(withPackageRoot({ color: false, rootDir: "/repo" }, undefined)).toStrictEqual({
			color: false,
			rootDir: "/repo",
		});
	});

	it("should point the options at the package root", () => {
		expect.assertions(1);

		expect(
			withPackageRoot({ color: false, rootDir: "/repo" }, "/repo/packages/a"),
		).toStrictEqual({ color: false, rootDir: "/repo/packages/a" });
	});
});
