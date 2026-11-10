import { fromAny } from "@total-typescript/shoehorn";

import type { ResolvedConfig as C12ResolvedConfig, LoadConfigOptions } from "c12";
import type { Mock } from "vitest";
import { vi } from "vitest";

import type { ProjectConfigInput } from "#src/config/project-config-file.ts";
import type { FileSystem } from "#src/utils/file-system.ts";
import { createMemoryFileSystem } from "#test/mocks/memory-file-system.ts";

export interface ProjectSeamStubs {
	configLoader: Mock<(options: LoadConfigOptions) => Promise<C12ResolvedConfig>>;
	resolveTsconfigDirectories: Mock<SeamOf<"resolveTsconfigDirectories">>;
	seams: ProjectConfigInput & { fileSystem: FileSystem };
}

type SeamOf<K extends keyof ProjectConfigInput> = NonNullable<ProjectConfigInput[K]>;

export function createProjectSeams(): ProjectSeamStubs {
	const configLoader = vi.fn<(options: LoadConfigOptions) => Promise<C12ResolvedConfig>>();
	const resolveTsconfigDirectories = vi.fn<SeamOf<"resolveTsconfigDirectories">>();
	resolveTsconfigDirectories.mockReturnValue({ outDir: "out", rootDir: "src" });

	return {
		configLoader,
		resolveTsconfigDirectories,
		seams: {
			configLoader: fromAny(configLoader),
			fileSystem: createMemoryFileSystem().fileSystem,
			resolveTsconfigDirectories,
		},
	};
}
