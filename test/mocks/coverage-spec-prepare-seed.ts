import { fromAny } from "@total-typescript/shoehorn";

import * as path from "node:path";
import process from "node:process";

import type { ResolvedConfig } from "#src/config/resolved-config.ts";
import type { TsconfigReader } from "#src/tsconfig/tsconfig-mappings.ts";
import type { MemoryFileSystem, MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

export const PROJECT_DIR: string = process.cwd();

const ROJO_PROJECT = {
	name: "test",
	tree: {
		$className: "DataModel",
		ReplicatedStorage: {
			$path: "out-tsc/test/client",
		},
	},
};

export interface SeedOptions {
	luauRoot?: string;
	rojoProject?: string;
}

export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return createResolvedConfig({
		collectCoverage: true,
		collectCoverageFrom: [],
		rojoProject: path.join(PROJECT_DIR, "default.project.json"),
		rootDir: PROJECT_DIR,
		...overrides,
	});
}

export function readingOutDirectory(outDirectory?: string): TsconfigReader {
	return fromAny(() => {
		return outDirectory === undefined
			? null
			: {
					config: { compilerOptions: { outDir: outDirectory } },
					path: path.join(PROJECT_DIR, "tsconfig.json"),
				};
	});
}

export function seedInto(
	volume: MemoryVolume,
	{
		luauRoot = "out-tsc/test",
		rojoProject = path.join(PROJECT_DIR, "default.project.json"),
	}: SeedOptions = {},
): void {
	volume.mkdirSync(PROJECT_DIR, { recursive: true });
	volume.mkdirSync(luauRoot, { recursive: true });
	volume.writeFileSync(`${luauRoot}/init.luau`, "local x = 1");
	volume.writeFileSync(rojoProject, JSON.stringify(ROJO_PROJECT));
}

export function seedFilesystem(options: SeedOptions = {}): MemoryFileSystem {
	const memory = createMemoryFileSystem();
	seedInto(memory.volume, options);
	return memory;
}
