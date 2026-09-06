import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import type { Mock } from "vitest";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/mocks/memory-file-system.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { ConfigLoadOptions } from "./loader.ts";
import { loadRawConfig } from "./loader.ts";

type C12Loader = (options: LoadConfigOptions) => Promise<C12ResolvedConfig>;

function emptyConfigLoader(): Mock<C12Loader> {
	const configLoader = vi.fn<C12Loader>();
	configLoader.mockResolvedValue({ config: {}, cwd: "/repo", layers: [] });

	return configLoader;
}

function seamsFor(configLoader: Mock<C12Loader>, fileSystem: FileSystem): ConfigLoadOptions {
	return { configLoader: fromAny(configLoader), fileSystem };
}

describe("c12 loader boundary", () => {
	it("should isolate implicit config discovery from ambient configuration sources", async () => {
		expect.assertions(3);

		const configLoader = emptyConfigLoader();
		const { fileSystem } = createMemoryFileSystem();

		await expect(
			loadRawConfig(undefined, "/repo", seamsFor(configLoader, fileSystem)),
		).resolves.toStrictEqual({});

		const [options] = configLoader.mock.calls[0]!;
		const { merger, ...plainOptions } = options;

		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFileRequired: false,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should require and name an explicitly requested config file", async () => {
		expect.assertions(2);

		const configLoader = emptyConfigLoader();
		const { fileSystem } = createMemoryFileSystem();

		await loadRawConfig("configs/jest.config.ts", "/repo", seamsFor(configLoader, fileSystem));

		const [options] = configLoader.mock.calls[0]!;
		const { merger, ...plainOptions } = options;

		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFile: "configs/jest.config.ts",
			configFileRequired: true,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});

	it("should provide the filesystem importer only in SEA mode", async () => {
		expect.assertions(3);

		const configLoader = emptyConfigLoader();
		const { fileSystem } = createMemoryFileSystem();
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		vi.stubEnv("JEST_ROBLOX_SEA", "true");

		await loadRawConfig("jest.config.json", "/repo", seamsFor(configLoader, fileSystem));

		const [options] = configLoader.mock.calls[0]!;
		const { import: importConfig, merger, ...plainOptions } = options;

		expect(importConfig).toBeTypeOf("function");
		expect(merger).toBeTypeOf("function");
		expect(plainOptions).toStrictEqual({
			name: "jest",
			configFile: "jest.config.json",
			configFileRequired: true,
			cwd: "/repo",
			dotenv: false,
			extend: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
	});
});
