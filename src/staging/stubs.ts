import path from "node:path";

import type { ProjectTestConfig } from "../config/config-types.ts";
import { STUB_KEYS } from "../config/options.ts";
import type { ResolvedProjectConfig } from "../config/projects.ts";
import type { ResolvedConfig } from "../config/resolved-config.ts";
import type { FileSystem } from "../utils/file-system.ts";
import {
	hasUserAuthoredConfig,
	isGeneratedStub,
	removeLegacyGeneratedStub,
	STUB_FILENAME,
} from "./stub-files.ts";
import type { StubConfig } from "./stub-serializer.ts";
import { serializeToLuau } from "./stub-serializer.ts";
import type { StubMount } from "./synthesizer-types.ts";

/**
 * Throw when a mount path escapes `rootDirectory`.
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
 * One `jest.config` stub mount per rojo mount.
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
 * Delete leftover generated stubs at known mount paths.
 * @param options - Projects, root directory and file system.
 * @returns The stub paths that were deleted.
 */
export function cleanLeftoverStubs({
	fileSystem,
	projects,
	rootDirectory,
}: {
	readonly fileSystem: FileSystem;
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
 * @param options - Projects, root directory, output root and file system.
 */
export function generateProjectStubs({
	fileSystem,
	outputRoot,
	projects,
	rootDirectory,
}: {
	/** File system to read and write through. */
	readonly fileSystem: FileSystem;
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

function generateProjectConfigs(
	projects: Array<{
		config: StubConfig;
		outputPath: string;
	}>,
	fileSystem: FileSystem,
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
		if (STUB_KEYS.has(key)) {
			Reflect.set(result, key, value);
		}
	}

	return result;
}
