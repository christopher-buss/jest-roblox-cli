import { loadRojoProject, resolveNestedProjects } from "@isentinel/rojo-utils";
import type { RojoTreeNode } from "@isentinel/rojo-utils";

import * as path from "node:path";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import type { InstrumentUniverse } from "../instrument/instrument-universe.ts";
import { nodeTsconfigReader, type TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { discoverLuauRoots, isLuauFile } from "./discover-roots.ts";
import type { NarrowedMount } from "./narrow-roots.ts";
import { narrowRootsInFrame } from "./narrow-roots.ts";
import { collectRojoMounts } from "./root-reachability.ts";
import type { PackageIgnore, WorkspacePackageDescriptor } from "./workspace-prepare-types.ts";

interface NarrowPackageOptions {
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	ignore: PackageIgnore;
	tsconfigReader?: TsconfigReader;
	universe: InstrumentUniverse | undefined;
}

/**
 * Narrows the package's roots to its coverage universe, package-relative.
 * @param options - Package descriptor, file system, ignore matchers and
 * universe.
 * @returns Narrowed mounts with package-relative paths.
 */
export function narrowPackageRoots({
	descriptor,
	fileSystem,
	ignore,
	tsconfigReader = nodeTsconfigReader,
	universe,
}: NarrowPackageOptions): Array<NarrowedMount> {
	const tree = resolvePackageTree(descriptor, fileSystem);
	const rojoDirectory = path.dirname(descriptor.rojoProjectPath);
	const resolvedRoots = resolvePackageRoots({
		descriptor,
		fileSystem,
		ignore,
		tree,
		tsconfigReader,
	});
	return narrowRootsInFrame(resolvedRoots, {
		fileSystem,
		frame: descriptor.packageDirectory,
		isCopyIgnored: ignore.copyMatcher,
		rojoMounts: collectRojoMounts(tree, rojoDirectory),
		universe,
	});
}

function resolvePackageTree(
	descriptor: WorkspacePackageDescriptor,
	fileSystem: FileSystem,
): RojoTreeNode {
	const project = loadRojoProject(descriptor.rojoProjectPath, fileSystem);
	return resolveNestedProjects(
		{ rootDirectory: path.dirname(descriptor.rojoProjectPath), tree: project.tree },
		fileSystem,
	);
}

function readTsconfigRoots(
	packageDirectory: string,
	tsconfigReader: TsconfigReader,
): Array<string> | undefined {
	const outDirectory = tsconfigReader(packageDirectory)?.config.compilerOptions?.outDir;
	return outDirectory === undefined ? undefined : [outDirectory];
}

function resolvePackageRoots({
	descriptor,
	fileSystem,
	ignore,
	tree,
	tsconfigReader,
}: {
	descriptor: WorkspacePackageDescriptor;
	fileSystem: FileSystem;
	ignore: PackageIgnore;
	tree: RojoTreeNode;
	tsconfigReader: TsconfigReader;
}): Array<string> {
	const roots = discoverLuauRoots({
		check: {
			frameName: "the package",
			subject: descriptor.name,
			warn: (text) => {
				process.stderr.write(text);
			},
		},
		explicit: descriptor.luauRoots,
		fileSystem,
		frame: descriptor.packageDirectory,
		holdsRoot: isLuauFile,
		isIgnored: ignore.matcher,
		rojo: { rojoDirectory: path.dirname(descriptor.rojoProjectPath), tree },
	});
	const resolvedRoots = roots ?? readTsconfigRoots(descriptor.packageDirectory, tsconfigReader);
	if (resolvedRoots === undefined || resolvedRoots.length === 0) {
		throw new ConfigError(
			`Could not determine luauRoots for package "${descriptor.name}". Set luauRoots or ensure tsconfig has outDir.`,
		);
	}

	return resolvedRoots;
}
