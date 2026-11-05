import path from "node:path";

import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { PROJECT_TEST_KEYS } from "./config-keys.ts";
import { ConfigError } from "./errors.ts";
import type { ResolvedProjectConfig } from "./projects.ts";
import type { ProjectTestConfig, ResolvedConfig } from "./schema.ts";
import {
	hasUserAuthoredConfig,
	isGeneratedStub,
	mountsWithoutUserConfig,
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

/** The two trees a stub pass reads and writes, and what reaches them. */
interface StubRoots {
	fileSystem: FileSystem;
	rootDirectory: string;
	writeRoot: string;
}

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
 * Write a generated stub at every mount of every project, after the collision
 * rule passes for each.
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
	/** Root stubs are written under. Defaults to `rootDirectory`. */
	readonly outputRoot?: string | undefined;
	/** Projects to write stubs for. */
	readonly projects: Array<ResolvedProjectConfig>;
	/** Root the project mount paths are relative to. */
	readonly rootDirectory: string;
}): void {
	const writeRoot = outputRoot ?? rootDirectory;
	const entries: Array<{ config: StubConfig; outputPath: string }> = [];

	for (const project of projects) {
		assertStubCollisionRule({ fileSystem, project, rootDirectory });

		const stubConfig: StubConfig = {
			...buildStubConfig(project.config),
			displayName: project.displayName,
			testMatch: project.testMatch,
		};

		entries.push(
			...buildStubEntriesForProject({
				fileSystem,
				project,
				rootDirectory,
				stubConfig,
				writeRoot,
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

/**
 * For a multi-mount project, the stubs-per-mount rule requires that a
 * user-authored config at any tracked FS path must appear at every tracked
 * FS path (or none). Throws `ConfigError` when the project has partial
 * coverage — some mounts have a user config and others don't.
 *
 * @param options - Project, root directory and file system.
 */
function assertStubCollisionRule({
	fileSystem = nodeFileSystem,
	project,
	rootDirectory,
}: {
	readonly fileSystem?: FileSystem;
	readonly project: ResolvedProjectConfig;
	readonly rootDirectory: string;
}): void {
	const withUser: Array<string> = [];
	const withoutUser: Array<string> = [];

	for (const mount of project.rojoMounts) {
		assertMountContained({ fsPath: mount.fsPath, project, rootDirectory });

		const absolute = path.resolve(rootDirectory, mount.fsPath);
		if (hasUserAuthoredConfig(absolute, fileSystem)) {
			withUser.push(mount.fsPath);
		} else {
			withoutUser.push(mount.fsPath);
		}
	}

	if (withUser.length === 0 || withoutUser.length === 0) {
		return;
	}

	const withUserList = withUser.join(", ");
	const withoutUserList = withoutUser.join(", ");
	throw new ConfigError(
		`Project "${project.displayName}": user-authored jest config present at some mounts but not others.\n\n` +
			`With user config: ${withUserList}\n` +
			`Without user config: ${withoutUserList}\n\n` +
			"For multi-mount projects, either every tracked mount must have a user config, or none.",
	);
}

function buildStubEntriesForProject({
	fileSystem,
	project,
	rootDirectory,
	stubConfig,
	writeRoot,
}: StubRoots & {
	readonly project: ResolvedProjectConfig;
	readonly stubConfig: StubConfig;
}): Array<{ config: StubConfig; outputPath: string }> {
	return mountsWithoutUserConfig({ fileSystem, mounts: project.rojoMounts, rootDirectory }).map(
		(mount) => {
			return {
				config: stubConfig,
				outputPath: path.resolve(writeRoot, mount.fsPath, STUB_FILENAME),
			};
		},
	);
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
