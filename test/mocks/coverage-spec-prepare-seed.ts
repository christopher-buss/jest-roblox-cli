import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig } from "#src/config/schema.ts";
import type { TsconfigReader } from "#src/executor/tsconfig-mappings.ts";
import type { MemoryFileSystem, MemoryVolume } from "#test/mocks/memory-file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";
import { createResolvedConfig } from "#test/mocks/resolved-config.ts";

export const ROJO_PROJECT = {
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
	return createResolvedConfig({ collectCoverage: true, rootDir: "/project", ...overrides });
}

/**
 * A reader answering with one tsconfig `outDir`, or with no tsconfig at all.
 * Stateless, so no case can leave a reading behind for the next one.
 * @param outDirectory - The `outDir` to report; omit for no tsconfig.
 * @returns The stub reader.
 */
export function readingOutDirectory(outDirectory?: string): TsconfigReader {
	return fromAny(() => {
		return outDirectory === undefined
			? null
			: {
					config: { compilerOptions: { outDir: outDirectory } },
					path: "/project/tsconfig.json",
				};
	});
}

/**
 * Lay one instrumentable root and the rojo project that mounts it onto an
 * existing volume.
 *
 * @param volume - Where they land.
 * @param options - Where the root and the project file sit.
 */
export function seedInto(
	volume: MemoryVolume,
	{ luauRoot = "out-tsc/test", rojoProject = "/project/default.project.json" }: SeedOptions = {},
): void {
	volume.mkdirSync("/project", { recursive: true });
	volume.mkdirSync(luauRoot, { recursive: true });
	volume.writeFileSync(`${luauRoot}/init.luau`, "local x = 1");
	volume.writeFileSync(rojoProject, JSON.stringify(ROJO_PROJECT));
}

/**
 * One instrumentable root and its Rojo project.
 *
 * @param options - Where the root and the project file sit.
 * @returns The seeded file system.
 */
export function seedFilesystem(options: SeedOptions = {}): MemoryFileSystem {
	const memory = createMemoryFileSystem();
	seedInto(memory.volume, options);
	return memory;
}
