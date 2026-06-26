import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import {
	narrowMappedForAgentTable,
	projectRootFilter,
	sourceTwinFilter,
} from "./agent-table-filter.ts";
import type { MappedCoverageResult, MappedFileCoverage } from "./mapper.ts";

function abs(relative: string): string {
	return normalizeWindowsPath(path.resolve("/repo", relative));
}

function createMappedFile(filePath: string): MappedFileCoverage {
	return {
		b: {},
		branchMap: {},
		f: {},
		fnMap: {},
		path: filePath,
		s: {},
		statementMap: {},
	};
}

function createResult(paths: Array<string>): MappedCoverageResult {
	const files: Record<string, MappedFileCoverage> = {};
	for (const filePath of paths) {
		files[filePath] = createMappedFile(filePath);
	}

	return { files };
}

describe(sourceTwinFilter, () => {
	it("should keep the source twin of a .test.ts file", () => {
		expect.assertions(2);

		const keep = sourceTwinFilter(["src/foo.test.ts"], "/repo");

		expect(keep(abs("src/foo.ts"))).toBeTrue();
		expect(keep(abs("src/bar.ts"))).toBeFalse();
	});

	it("should keep the source twin of a .spec.tsx file preserving the extension", () => {
		expect.assertions(2);

		const keep = sourceTwinFilter(["src/widget.spec.tsx"], "/repo");

		expect(keep(abs("src/widget.tsx"))).toBeTrue();
		expect(keep(abs("src/widget.ts"))).toBeFalse();
	});

	it("should strip the -d type-test marker", () => {
		expect.assertions(1);

		const keep = sourceTwinFilter(["src/types.test-d.ts"], "/repo");

		expect(keep(abs("src/types.ts"))).toBeTrue();
	});

	it("should map a .test.luau file to its .luau twin", () => {
		expect.assertions(1);

		const keep = sourceTwinFilter(["src/init.test.luau"], "/repo");

		expect(keep(abs("src/init.luau"))).toBeTrue();
	});

	it("should match route-group directories with glob metacharacters literally", () => {
		expect.assertions(2);

		const keep = sourceTwinFilter(["src/(routes)/page.test.ts"], "/repo");

		expect(keep(abs("src/(routes)/page.ts"))).toBeTrue();
		expect(keep(abs("src/x/page.ts"))).toBeFalse();
	});

	it("should resolve absolute positional paths against their own location", () => {
		expect.assertions(1);

		const keep = sourceTwinFilter([abs("src/foo.test.ts")], "/repo");

		expect(keep(abs("src/foo.ts"))).toBeTrue();
	});

	it("should keep a file with no test marker as its own twin", () => {
		expect.assertions(1);

		const keep = sourceTwinFilter(["src/plain.ts"], "/repo");

		expect(keep(abs("src/plain.ts"))).toBeTrue();
	});
});

describe(projectRootFilter, () => {
	it("should keep files under a project root", () => {
		expect.assertions(2);

		const keep = projectRootFilter([abs("src/shared")]);

		expect(keep(abs("src/shared/player.ts"))).toBeTrue();
		expect(keep(abs("src/server/boot.ts"))).toBeFalse();
	});

	it("should match the root directory itself", () => {
		expect.assertions(1);

		const keep = projectRootFilter([abs("src/shared")]);

		expect(keep(abs("src/shared"))).toBeTrue();
	});

	it("should not match a sibling sharing a name prefix", () => {
		expect.assertions(1);

		const keep = projectRootFilter([abs("src/shared")]);

		expect(keep(abs("src/shared-extra/util.ts"))).toBeFalse();
	});

	it("should accept any of several roots", () => {
		expect.assertions(2);

		const keep = projectRootFilter([abs("src/shared"), abs("src/client")]);

		expect(keep(abs("src/client/ui.ts"))).toBeTrue();
		expect(keep(abs("src/server/svc.ts"))).toBeFalse();
	});
});

describe(narrowMappedForAgentTable, () => {
	it("should drop universe files the predicate rejects", () => {
		expect.assertions(2);

		const result = createResult([abs("src/foo.ts"), abs("src/bar.ts")]);
		const narrowed = narrowMappedForAgentTable(
			result,
			sourceTwinFilter(["src/foo.test.ts"], "/repo"),
		);

		expect(Object.keys(narrowed.files)).toStrictEqual([abs("src/foo.ts")]);
		expect(narrowed.files[abs("src/bar.ts")]).toBeUndefined();
	});

	it("should resolve relative universe keys before testing the predicate", () => {
		expect.assertions(1);

		const relativeKey = "src/foo.ts";
		const result = createResult([relativeKey]);
		const keep = sourceTwinFilter(
			[path.resolve(process.cwd(), "src/foo.test.ts")],
			process.cwd(),
		);

		const narrowed = narrowMappedForAgentTable(result, keep);

		expect(Object.keys(narrowed.files)).toStrictEqual([relativeKey]);
	});

	it("should return an empty universe when nothing matches", () => {
		expect.assertions(1);

		const result = createResult([abs("src/foo.ts")]);
		const narrowed = narrowMappedForAgentTable(result, () => false);

		expect(narrowed.files).toStrictEqual({});
	});

	it("should keep the full universe when everything matches", () => {
		expect.assertions(1);

		const result = createResult([abs("src/foo.ts"), abs("src/bar.ts")]);
		const narrowed = narrowMappedForAgentTable(result, () => true);

		expect(Object.keys(narrowed.files)).toHaveLength(2);
	});
});
