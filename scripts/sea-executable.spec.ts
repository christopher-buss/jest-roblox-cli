import { describe, expect, it, vi } from "vitest";

import type { MemoryFileSystem } from "../test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "../test/mocks/memory-file-system.ts";
import type { SeaExecutableOptions } from "./sea-executable.ts";
import { resolveSeaExecutable } from "./sea-executable.ts";

const NODE = "/node/bin/node";
const CACHE = "/cache";

function seed(): MemoryFileSystem {
	return createMemoryFileSystem({ [NODE]: "symbols+code" }, "/");
}

function options(
	{ fileSystem }: MemoryFileSystem,
	overrides: Partial<SeaExecutableOptions> = {},
): SeaExecutableOptions {
	return {
		cacheDirectory: CACHE,
		execPath: NODE,
		fileSystem,
		platform: "linux",
		strip: vi.fn<(file: string) => void>(),
		version: "v26.5.0",
		...overrides,
	};
}

describe(resolveSeaExecutable, () => {
	it("should build from the running node off linux", () => {
		expect.assertions(1);

		expect(resolveSeaExecutable(options(seed(), { platform: "win32" }))).toBe(NODE);
	});

	it("should strip a copy of node on linux", () => {
		expect.assertions(3);

		const memory = seed();
		const strip = vi.fn<(file: string) => void>((file) => {
			memory.volume.writeFileSync(file, "code");
		});

		const executable = resolveSeaExecutable(options(memory, { strip }));

		expect(executable).toBe("/cache/node-v26.5.0-linux-stripped");
		expect(memory.volume.readFileSync(executable, "utf8")).toBe("code");
		expect(memory.volume.readFileSync(NODE, "utf8")).toBe("symbols+code");
	});

	it("should reuse a copy stripped by an earlier build", () => {
		expect.assertions(1);

		const memory = seed();
		const strip = vi.fn<(file: string) => void>();
		resolveSeaExecutable(options(memory, { strip }));

		resolveSeaExecutable(options(memory, { strip }));

		expect(strip).toHaveBeenCalledOnce();
	});

	it("should not publish a copy whose strip failed", () => {
		// An interrupted strip must not leave a half-written binary where the
		// next build would take it as finished.
		expect.assertions(2);

		const memory = seed();
		const strip = vi.fn<(file: string) => void>(() => {
			throw new Error("strip: not found");
		});

		expect(() => resolveSeaExecutable(options(memory, { strip }))).toThrow("strip");
		expect(memory.volume.existsSync("/cache/node-v26.5.0-linux-stripped")).toBeFalse();
	});
});
