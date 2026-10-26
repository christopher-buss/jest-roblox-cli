import { fromAny } from "@total-typescript/shoehorn";

import type { LoadConfigOptions } from "c12";
import * as path from "node:path";

import type { MemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import type { ConfigLoader } from "../../src/config/loader.ts";
import type { Config } from "../../src/config/schema.ts";

interface ConfigFixture extends Pick<MemoryFileSystem, "fileSystem"> {
	configLoader: ConfigLoader;
	rootDirectory: string;
}

export function createConfigFixture(layers: Record<string, Config | Error> = {}): ConfigFixture {
	const rootDirectory = path.resolve("config-fixture");
	const files = new Map(
		Object.entries(layers).map(([name, config]) => [path.resolve(rootDirectory, name), config]),
	);
	const { fileSystem } = createMemoryFileSystem(
		Object.fromEntries(Array.from(files.keys(), (file) => [file, "{}"])),
	);
	const configLoader: ConfigLoader = fromAny(async (options: LoadConfigOptions<Config>) => {
		return Promise.resolve().then(() => {
			const configFile = path.resolve(
				options.cwd ?? rootDirectory,
				options.configFile ?? "jest.config.mjs",
			);
			const config = files.get(configFile);
			if (config instanceof Error) {
				throw config;
			}

			if (config === undefined && options.configFileRequired === true) {
				throw new Error(`${configFile} cannot be resolved`);
			}

			return { config: config ?? {}, configFile };
		});
	});
	return { configLoader, fileSystem, rootDirectory };
}
