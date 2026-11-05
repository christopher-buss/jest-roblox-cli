import { fromPartial } from "@total-typescript/shoehorn";

import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";

import type { SourceMapper } from "../source-mapper/index.ts";
import { getTerminalWidth, resolveDisplayPath } from "./shared.ts";

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

		expect(resolveDisplayPath("out/a.spec.luau")).toBe("out/a.spec.luau");
	});

	it("should use the source mapper's display path when it has one", () => {
		expect.assertions(1);

		const sourceMapper = fromPartial<SourceMapper>({
			resolveDisplayPath: () => "src/a.spec.ts",
		});

		expect(resolveDisplayPath("out/a.spec.luau", sourceMapper)).toBe("src/a.spec.ts");
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
