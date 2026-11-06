import { fromAny } from "@total-typescript/shoehorn";

import type { LoadConfigOptions } from "c12";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createConfigFixture } from "#test/mocks/config-fixture.ts";
import { createLuteChildProcess } from "#test/mocks/lute-child-process.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { ConfigLayer } from "./config-layers.ts";
import { invokeC12, processExtends } from "./config-layers.ts";
import type { ConfigLoader } from "./loader.ts";
import type { Config } from "./schema.ts";

async function extendFixture(
	layers: NonNullable<Parameters<typeof createConfigFixture>[0]>,
): Promise<Config> {
	const { configLoader, fileSystem, rootDirectory } = createConfigFixture(layers);
	const configFile = path.resolve(rootDirectory, "jest.config.mjs");
	const entry = layers["jest.config.mjs"];
	const result: ConfigLayer = { config: fromAny(entry), configFile };

	return processExtends({
		context: { childProcess: createLuteChildProcess({}), configLoader, fileSystem },
		result,
		visited: new Set(),
	});
}

describe(processExtends, () => {
	it("should merge a shared base reached by two branches", async () => {
		expect.assertions(4);

		const result = await extendFixture({
			"a.mjs": { extends: "./base.mjs", timeout: 1000 },
			"b.mjs": { extends: "./base.mjs", port: 5000 },
			"base.mjs": { extends: "./root.mjs", test: { setupFiles: ["shared.luau"] } },
			"jest.config.mjs": { extends: ["./a.mjs", "./b.mjs"], test: { verbose: true } },
			"root.mjs": { placeFile: "root.rbxl" },
		});

		expect(result.timeout).toBe(1000);
		expect(result.port).toBe(5000);
		expect(result.placeFile).toBe("root.rbxl");
		expect(result.test!.setupFiles).toStrictEqual(["shared.luau", "shared.luau"]);
	});

	it("should resolve an absolute extends path", async () => {
		expect.assertions(1);

		const parent = path.resolve("parent.mjs");
		const result = await extendFixture({
			"jest.config.mjs": { extends: parent },
			[parent]: { timeout: 1234 },
		});

		expect(result.timeout).toBe(1234);
	});

	it("should reject circular inheritance and retain missing-parent context", async () => {
		expect.assertions(3);

		await expect(
			extendFixture({
				"a.mjs": { extends: "./jest.config.mjs" },
				"jest.config.mjs": { extends: "./a.mjs" },
			}),
		).rejects.toThrow(
			/^Circular extends detected: .*jest\.config\.mjs -> .*a\.mjs -> .*jest\.config\.mjs\.$/,
		);
		await expect(
			extendFixture({ "jest.config.mjs": { extends: "./missing.mjs" } }),
		).rejects.toThrow("Failed to resolve extends");
		await expect(
			extendFixture({ "jest.config.mjs": { extends: "./missing.mjs" } }),
		).rejects.toHaveProperty("cause.message");
	});

	it("should anchor a relative workspace.root to the declaring file", async () => {
		expect.assertions(1);

		const { rootDirectory } = createConfigFixture();
		const result = await extendFixture({
			"jest.config.mjs": { workspace: { packages: ["packages/*"], root: "." } },
		});

		expect(result.workspace!.root).toBe(rootDirectory);
	});
});

describe(invokeC12, () => {
	it("should import a JSON config through the supplied filesystem in SEA mode", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const { fileSystem } = createMemoryFileSystem({
			"/config.json": '{"test":{"verbose":true}}',
		});
		const configLoader: ConfigLoader = fromAny(async (options: LoadConfigOptions<Config>) => {
			return { config: await options.import!("/config.json") };
		});

		const result = await invokeC12({
			configFile: undefined,
			configLoader,
			cwd: "/",
			fileSystem,
		});

		expect(result.config).toStrictEqual({ test: { verbose: true } });
	});

	it("should import an ESM config through the native SEA loader", async () => {
		expect.assertions(1);

		vi.stubEnv("JEST_ROBLOX_SEA", "true");
		const { fileSystem } = createMemoryFileSystem();
		const configLoader: ConfigLoader = fromAny(async (options: LoadConfigOptions<Config>) => {
			const module: { default: Config } = fromAny(
				await options.import!(
					path.resolve(import.meta.dirname, "../../test/fixtures/sea.config.mjs"),
				),
			);
			return { config: module.default };
		});

		const result = await invokeC12({
			configFile: undefined,
			configLoader,
			cwd: "/",
			fileSystem,
		});

		expect(result.config.test!.verbose).toBeTrue();
	});
});
