import { type } from "arktype";
import * as path from "node:path";

import type { TsconfigDirectories, TsconfigReader } from "../executor/tsconfig-mappings.ts";
import { nodeTsconfigReader, resolveTsconfigDirectories } from "../executor/tsconfig-mappings.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { projectConfigFileSchema } from "./config-validation.ts";
import type { ConfigLoader } from "./loader.ts";
import { nodeConfigLoader } from "./loader.ts";
import { findLuauConfigFile, loadLuauConfig } from "./luau-config-loader.ts";
import type { ProjectConfigFile, ProjectTestConfig } from "./schema.ts";

const TS_OR_LUAU_EXTENSION = /\.(tsx?|luau?)$/;

/** Collaborators a project config load reaches, all optional. */
export interface ProjectConfigInput extends ProjectConfigSeams {
	/** Where the project configs are read. Defaults to the real filesystem. */
	fileSystem?: FileSystem;
}

/** The collaborators that open handles of their own, past `fileSystem`. */
interface ProjectConfigSeams {
	/**
	 * How a Luau Config that holds code runs lute. Defaults to the real one.
	 */
	childProcess?: ChildProcessRunner;
	/** How a project config file is loaded. Defaults to the real c12. */
	configLoader?: ConfigLoader;
	/** How the `outDir`/`rootDir` a project compiles to are resolved. */
	resolveTsconfigDirectories?: typeof resolveTsconfigDirectories;
	/** How a project's tsconfig is located. Defaults to the real reader. */
	tsconfigReader?: TsconfigReader;
}

const NODE_PROJECT_CONFIG_INPUT: Required<ProjectConfigInput> = {
	childProcess: nodeChildProcessRunner,
	configLoader: nodeConfigLoader,
	fileSystem: nodeFileSystem,
	resolveTsconfigDirectories,
	tsconfigReader: nodeTsconfigReader,
};

/**
 * Load a project config from a `jest.config.luau` under `filePath`, or else
 * through c12.
 *
 * @param options - Base directory, project path and optional collaborators.
 * @returns The validated project config, with `include` derived when absent.
 * @rejects If the config fails to load, fails validation or has no
 *   `displayName`.
 */
export async function loadProjectConfigFile({
	cwd,
	filePath,
	input,
}: {
	/** Directory the project path resolves against. */
	readonly cwd: string;
	/** Project config file or directory path. */
	readonly filePath: string;
	/** Collaborator overrides. */
	readonly input?: ProjectConfigInput | undefined;
}): Promise<ProjectConfigFile> {
	const settled = { ...NODE_PROJECT_CONFIG_INPUT, ...input };

	const luauConfigPath = findLuauConfigFile({
		cwd,
		directoryOrFile: filePath,
		fileSystem: settled.fileSystem,
	});
	if (luauConfigPath !== undefined) {
		return buildProjectConfigFromLuau({
			childProcess: settled.childProcess,
			directoryPath: filePath,
			fileSystem: settled.fileSystem,
			luauConfigPath,
		});
	}

	const config = parseProjectConfigFile(
		await loadProjectConfigViaC12({ configLoader: settled.configLoader, cwd, filePath }),
		filePath,
	);

	const name =
		typeof config.displayName === "string" ? config.displayName : config.displayName.name;

	if (name === "") {
		throw new Error(`Project config file "${filePath}" must have a displayName`);
	}

	const configDirectory = path.posix.dirname(filePath);
	const tsconfig = settled.resolveTsconfigDirectories(cwd, settled.tsconfigReader);
	deriveIncludeFromTestMatch({ ...tsconfig, config, configDirectory });

	return config;
}

/**
 * The c12 loader surfaces a resolution failure as a bare loader error;
 * re-throw it naming the config file so the user knows which project entry to
 * fix.
 *
 * @param options - Loader, base directory and config file path.
 * @returns The raw loaded config.
 * @rejects If the loader fails, with the config file named.
 */
async function loadProjectConfigViaC12({
	configLoader,
	cwd,
	filePath,
}: {
	readonly configLoader: ConfigLoader;
	readonly cwd: string;
	readonly filePath: string;
}): Promise<unknown> {
	try {
		const result = await configLoader({
			name: "jest-project",
			configFile: filePath,
			configFileRequired: true,
			cwd,
			dotenv: false,
			globalRc: false,
			omit$Keys: true,
			packageJson: false,
			rcFile: false,
		});
		return result.config;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to load project config file ${filePath}: ${message}`, {
			cause: err,
		});
	}
}

function parseProjectConfigFile(raw: unknown, filePath: string): ProjectConfigFile {
	const result = projectConfigFileSchema(raw);
	if (result instanceof type.errors) {
		throw new Error(`Invalid project config file "${filePath}": ${result.summary}`);
	}

	return result;
}

const luauProjectConfigSchema = type({
	"+": "delete",
	"automock?": "boolean",
	"clearMocks?": "boolean",
	"displayName": "string",
	"injectGlobals?": "boolean",
	"mockDataModel?": "boolean",
	"resetMocks?": "boolean",
	"resetModules?": "boolean",
	"restoreMocks?": "boolean",
	"setupFiles?": "string[]",
	"setupFilesAfterEnv?": "string[]",
	"slowTestThreshold?": "number",
	"testEnvironment?": "string",
	"testMatch?": "string[]",
	"testTimeout?": "number",
});

async function buildProjectConfigFromLuau({
	childProcess,
	directoryPath,
	fileSystem,
	luauConfigPath,
}: {
	readonly childProcess: ChildProcessRunner;
	readonly directoryPath: string;
	readonly fileSystem: FileSystem;
	readonly luauConfigPath: string;
}): Promise<ProjectTestConfig> {
	const raw = await loadLuauConfig(luauConfigPath, { childProcess, fileSystem });

	const { displayName } = raw;
	if (typeof displayName !== "string" || displayName === "") {
		throw new Error(`Luau config file "${luauConfigPath}" must have a displayName string`);
	}

	const validated = luauProjectConfigSchema(raw);
	if (validated instanceof type.errors) {
		throw new Error(`Invalid Luau config file "${luauConfigPath}": ${validated.summary}`);
	}

	const { testMatch } = validated;

	// Derive include from testMatch — append .luau extension and prefix with
	// directory path
	const include =
		testMatch !== undefined
			? testMatch.map((pattern) => path.posix.join(directoryPath, `${pattern}.luau`))
			: [path.posix.join(directoryPath, "**/*.spec.luau")];

	return { ...validated, include };
}

/**
 * When a project config provides `testMatch` but not `include`, derive
 * `include` by appending `.ts` and `.tsx` extensions.  This lets users
 * write project configs with the standard Jest `testMatch` field without
 * needing the CLI-specific `include`.
 *
 * @param options - Config to fill, its directory and tsconfig directories.
 */
function deriveIncludeFromTestMatch({
	config,
	configDirectory,
	outDir,
	rootDir,
}: TsconfigDirectories & {
	readonly config: ProjectConfigFile;
	readonly configDirectory: string;
}): void {
	if (config.include !== undefined) {
		return;
	}

	if (!Array.isArray(config.testMatch)) {
		return;
	}

	config.include = config.testMatch.flatMap((pattern) => {
		const withExtensions = TS_OR_LUAU_EXTENSION.test(pattern)
			? [pattern]
			: [`${pattern}.ts`, `${pattern}.tsx`];

		return withExtensions.map((extension) => path.posix.join(configDirectory, extension));
	});

	// Derive outDir from tsconfig rootDir/outDir mapping so the Rojo tree
	// mapping resolves correctly (e.g. src/shared → out/shared).
	if (rootDir === undefined || outDir === undefined || config.outDir !== undefined) {
		return;
	}

	const rootPrefix = `${rootDir}/`;
	if (configDirectory.startsWith(rootPrefix)) {
		config.outDir = `${outDir}/${configDirectory.slice(rootPrefix.length)}`;
	}
}
