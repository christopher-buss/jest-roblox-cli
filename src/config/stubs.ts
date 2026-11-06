import path from "node:path";

import type { StubMount } from "../staging/synthesizer-types.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { PROJECT_TEST_KEYS } from "./config-keys.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import type { ProjectTestConfig, ResolvedConfig } from "./schema.ts";
import {
	hasUserAuthoredConfig,
	isGeneratedStub,
	removeLegacyGeneratedStub,
	STUB_FILENAME,
} from "./stub-files.ts";
import type { StubConfig } from "./stub-serializer.ts";
import { serializeToLuau } from "./stub-serializer.ts";

/**
 * Write each stub config to its output path, skipping any directory that holds
 * a user-authored config.
 *
 * @param projects - Stub configs and the paths to write them to.
 * @param fileSystem - File system to write through.
 */
function generateProjectConfigs(
	projects: Array<{
		/** Stub fields to serialize. */
		config: StubConfig;
		/** File the stub is written to. */
		outputPath: string;
	}>,
	fileSystem: FileSystem = nodeFileSystem,
): void {
	for (const project of projects) {
		const directory = path.dirname(project.outputPath);
		if (hasUserAuthoredConfig(directory, fileSystem)) {
			continue;
		}

		const content = serializeToLuau(project.config);
		fileSystem.mkdirSync(directory, { recursive: true });
		fileSystem.writeFileSync(project.outputPath, content, "utf8");
		removeLegacyGeneratedStub(fileSystem, directory);
	}
}

// These project-level values are unwanted in the runtime stub:
// `outDir`/`root` are reconstructed per mount and Type Tests only run on the
// host. `displayName` and `include` are overwritten downstream, while
// `include`/`exclude` are dropped by `serializeToLuau`, so filtering those here
// would be redundant.
const STUB_SKIP_KEYS: ReadonlySet<string> = new Set([
	"outDir",
	// Host-only budget our own runner enforces around `Jest.runCLI`; it
	// reaches the runtime on the argv instead, and Jest would reject it here.
	"projectTimeout",
	"root",
	"typecheck",
]);

/**
 * Refuse to let any downstream write land outside `rootDirectory`. Mount
 * fsPaths originate from the rojo tree and `resolveNestedProjects` can emit
 * values with `..` segments (nested projects relocate paths); combined with
 * `path.resolve` on Windows, a permissive fsPath could send stub writes to
 * `D:\outside\...`. Guard at every write-site.
 *
 * @param options - Mount fsPath, its project and the root directory.
 */
export function assertMountContained({
	fsPath,
	project,
	rootDirectory,
}: {
	readonly fsPath: string;
	readonly project: ResolvedProjectConfig;
	readonly rootDirectory: string;
}): void {
	if (path.isAbsolute(fsPath)) {
		throw new Error(
			`Project "${project.displayName}" mount fsPath must be relative, got: ${fsPath}`,
		);
	}

	const rootResolved = path.resolve(rootDirectory);
	const mountResolved = path.resolve(rootDirectory, fsPath);
	if (mountResolved !== rootResolved && !mountResolved.startsWith(rootResolved + path.sep)) {
		throw new Error(
			`Project "${project.displayName}" mount fsPath escapes root directory: ${fsPath}`,
		);
	}
}

/**
 * `jest.config` stub mounts for a place build: one `$path` named-child per rojo
 * mount, pointing at the cache stub.
 *
 * @param options - Cache root and projects.
 * @param options.cacheRoot - Directory that holds the generated stubs.
 * @param options.projects - Projects whose mounts get a stub.
 * @returns One stub mount per project mount.
 */
export function collectStubMounts({
	cacheRoot,
	projects,
}: {
	readonly cacheRoot: string;
	readonly projects: Array<ResolvedProjectConfig>;
}): Array<StubMount> {
	return projects.flatMap((project) => {
		return project.rojoMounts.map((mount) => {
			return {
				absStubPath: path.resolve(cacheRoot, mount.fsPath, STUB_FILENAME),
				dataModelPath: mount.dataModelPath,
			};
		});
	});
}

/**
 * Pre-flight cleanup of marker-bearing leftover stubs at known mount paths.
 * Walks O(mounts), no recursive scan. Returns the cleaned paths so callers
 * can surface a `stderr` notice.
 *
 * Containment is enforced at two layers because either alone has a hole:
 * - `assertMountContained` rejects absolute paths and `..`-escapes lexically
 *   (Rojo-derived mounts can carry `..` segments when `resolveNestedProjects`
 *   relocates a path).
 * - `path.relative` against the realpath-resolved root catches symlinked
 *   mount directories pointing outside the package root. Platform-correct —
 *   it honours only the OS's separator, so a POSIX filename literally
 *   containing `\` doesn't pass as if it were a Windows escape.
 *
 * @param options - Projects, root directory and file system.
 * @returns The stub paths that were deleted.
 */
export function cleanLeftoverStubs({
	fileSystem = nodeFileSystem,
	projects,
	rootDirectory,
}: {
	readonly fileSystem?: FileSystem;
	readonly projects: Array<ResolvedProjectConfig>;
	readonly rootDirectory: string;
}): Array<string> {
	const cleaned: Array<string> = [];
	let realRoot: string | undefined;
	function realRootResolved(): string {
		realRoot ??= fileSystem.realpathSync(path.resolve(rootDirectory));
		return realRoot;
	}

	for (const project of projects) {
		cleaned.push(
			...cleanLeftoverStubsForProject({
				fileSystem,
				project,
				realRootResolved,
				rootDirectory,
			}),
		);
	}

	return cleaned;
}

/**
 * Write a generated stub at every mount of every project.
 *
 * @param options - Projects, root directory, optional output root and file
 *   system.
 */
export function generateProjectStubs({
	fileSystem = nodeFileSystem,
	outputRoot,
	projects,
	rootDirectory,
}: {
	/** File system to read and write through. */
	readonly fileSystem?: FileSystem;
	/** Root stubs are written under. */
	readonly outputRoot: string;
	/** Projects to write stubs for. */
	readonly projects: Array<ResolvedProjectConfig>;
	/** Root the project mount paths are relative to. */
	readonly rootDirectory: string;
}): void {
	const entries: Array<{ config: StubConfig; outputPath: string }> = [];

	for (const project of projects) {
		const stubConfig: StubConfig = {
			...buildStubConfig(project.config),
			displayName: project.displayName,
			testMatch: project.testMatch,
		};

		entries.push(
			...buildStubEntriesForProject({
				project,
				rootDirectory,
				stubConfig,
				writeRoot: outputRoot,
			}),
		);
	}

	generateProjectConfigs(entries, fileSystem);
}

function cleanLeftoverStubsForProject({
	fileSystem,
	project,
	realRootResolved,
	rootDirectory,
}: {
	readonly fileSystem: FileSystem;
	readonly project: ResolvedProjectConfig;
	readonly realRootResolved: () => string;
	readonly rootDirectory: string;
}): Array<string> {
	const cleaned: Array<string> = [];
	for (const mount of project.rojoMounts) {
		assertMountContained({ fsPath: mount.fsPath, project, rootDirectory });
		const stubPath = path.resolve(rootDirectory, mount.fsPath, STUB_FILENAME);
		if (!isGeneratedStub(stubPath, fileSystem)) {
			continue;
		}

		const realStubPath = fileSystem.realpathSync(stubPath);
		const root = realRootResolved();
		const relativePath = path.relative(root, realStubPath);
		const isInRoot = !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
		if (!isInRoot) {
			throw new Error(
				`Project "${project.displayName}" mount fsPath resolves outside root via symlink: ${mount.fsPath} → ${realStubPath}`,
			);
		}

		fileSystem.unlinkSync(stubPath);
		cleaned.push(stubPath);
	}

	return cleaned;
}

function buildStubEntriesForProject({
	project,
	rootDirectory,
	stubConfig,
	writeRoot,
}: {
	readonly project: ResolvedProjectConfig;
	readonly rootDirectory: string;
	readonly stubConfig: StubConfig;
	readonly writeRoot: string;
}): Array<{ config: StubConfig; outputPath: string }> {
	return project.rojoMounts.map((mount) => {
		assertMountContained({ fsPath: mount.fsPath, project, rootDirectory });
		return {
			config: stubConfig,
			outputPath: path.resolve(writeRoot, mount.fsPath, STUB_FILENAME),
		};
	});
}

function buildStubConfig(config: ResolvedConfig): Partial<ProjectTestConfig> {
	const result: Partial<ProjectTestConfig> = {};
	for (const [key, value] of Object.entries(config)) {
		if (PROJECT_TEST_KEYS.has(key) && !STUB_SKIP_KEYS.has(key)) {
			Reflect.set(result, key, value);
		}
	}

	return result;
}
