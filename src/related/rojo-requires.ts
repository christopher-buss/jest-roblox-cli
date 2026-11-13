import type { InstancePath, RequireCall } from "@isentinel/luau-ast";
import type { RbxPath, ReverseMapper } from "@isentinel/rojo-utils";
import { createReverseMapper, RojoResolver } from "@isentinel/rojo-utils";

import * as path from "node:path";

import type { Dirent, FileSystem } from "../utils/file-system.ts";

/**
 * Finds the file a Rojo require in `file` loads, or `undefined` when the tree
 * holds no module there.
 */
export type RojoRequireResolver = (file: string, call: RojoRequire) => string | undefined;

/** Inputs of {@link createRojoRequireResolver}. */
export interface RojoRequireResolverOptions {
	/** File system the Rojo project and its mounts are read from. */
	fileSystem: FileSystem;
	/** Absolute path of the Rojo project file. */
	rojoProjectPath: string;
}

type RojoRequireKind = "instance" | "ts-import" | "ts-package";

/** A require that resolves through the Rojo tree, not by string. */
type RojoRequire = Extract<RequireCall, Record<"kind", RojoRequireKind>>;

interface RojoTree {
	resolver: RojoResolver;
	reverse: ReverseMapper;
}

type EntryKind = "directory" | "file" | "missing";

interface LuauFileWalk {
	files: Set<string>;
	fileSystem: FileSystem;
}

interface TreeLookup {
	caller: RbxPath | undefined;
	reverse: ReverseMapper;
}

const DEFAULT_SCOPE = "@rbxts";
const LUAU_MODULE = /\.luau?$/;
const LUAU_SUFFIX = /\.luau$/;
const NODE_MODULES = "node_modules";

/**
 * Build the resolver of instance-path, `TS.import` and `TS.getModule` requires
 * through a Rojo project. The project is walked, and every Luau file under its
 * mounts listed, on the first call.
 *
 * @param options - Where the project is read, and its path.
 * @returns A function from a requiring file and its call to the loaded file.
 */
export function createRojoRequireResolver({
	fileSystem,
	rojoProjectPath,
}: RojoRequireResolverOptions): RojoRequireResolver {
	let tree: RojoTree | undefined;
	return (file, call) => {
		tree ??= loadRojoTree(fileSystem, rojoProjectPath);
		const caller = tree.resolver.getRbxPathFromFilePath(file);
		return resolveInTree(call, { caller, reverse: tree.reverse });
	};
}

function readEntryKind(
	fileSystem: FileSystem,
	{ entry, target }: { entry: Dirent; target: string },
): EntryKind {
	// Stryker disable next-line ConditionalExpression,BlockStatement: fast path
	if (!entry.isSymbolicLink()) {
		return entry.isDirectory() ? "directory" : "file";
	}

	const stat = fileSystem.statSync(target, { throwIfNoEntry: false });
	if (stat === undefined) {
		return "missing";
	}

	return stat.isDirectory() ? "directory" : "file";
}

function collectDirectory(walk: LuauFileWalk, directory: string): void {
	const entries = walk.fileSystem.readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		const target = path.join(directory, entry.name);
		const kind = readEntryKind(walk.fileSystem, { entry, target });
		if (kind === "directory") {
			collectDirectory(walk, target);
		} else if (kind === "file" && LUAU_MODULE.test(target)) {
			walk.files.add(target);
		}
	}
}

function collectLuauFiles(walk: LuauFileWalk, target: string): void {
	const stat = walk.fileSystem.statSync(target, { throwIfNoEntry: false });
	if (stat?.isDirectory() === true) {
		collectDirectory(walk, target);
	} else if (stat !== undefined && LUAU_MODULE.test(target)) {
		walk.files.add(target);
	}
}

function loadRojoTree(fileSystem: FileSystem, rojoProjectPath: string): RojoTree {
	const resolver = RojoResolver.fromPath(rojoProjectPath, fileSystem);
	const walk = { files: new Set<string>(), fileSystem } satisfies LuauFileWalk;
	for (const partition of resolver.getPartitions()) {
		collectLuauFiles(walk, partition.fsPath);
	}

	for (const [file] of resolver.getState().filePathToRbxPathMap) {
		const targets = new Set([file, file.replace(LUAU_SUFFIX, ".lua")]);
		for (const target of targets) {
			collectLuauFiles(walk, target);
		}
	}

	return {
		resolver,
		reverse: createReverseMapper([...walk.files], (file) => {
			return resolver.getRbxPathFromFilePath(file);
		}),
	};
}

function walkInstancePath(
	instancePath: InstancePath,
	caller: RbxPath | undefined,
): RbxPath | undefined {
	const start = instancePath.root === "game" ? [] : caller;
	if (start === undefined) {
		return undefined;
	}

	const target = [...start];
	for (const step of instancePath.segments) {
		if (step.kind === "child") {
			target.push(step.name);
		} else if (target.pop() === undefined) {
			return undefined;
		}
	}

	return target;
}

function findPackageModule(
	segments: ReadonlyArray<string>,
	{ caller, reverse }: TreeLookup,
): string | undefined {
	if (caller === undefined) {
		return undefined;
	}

	const scoped = segments[0]?.startsWith("@") === true ? segments : [DEFAULT_SCOPE, ...segments];
	for (let depth = caller.length; depth >= 0; depth--) {
		const file = reverse.resolve([...caller.slice(0, depth), NODE_MODULES, ...scoped]);
		if (file !== undefined) {
			return file;
		}
	}

	return undefined;
}

function resolveRbxPath(reverse: ReverseMapper, target: RbxPath | undefined): string | undefined {
	return target === undefined ? undefined : reverse.resolve(target);
}

function resolveInTree(call: RojoRequire, lookup: TreeLookup): string | undefined {
	switch (call.kind) {
		case "instance": {
			return resolveRbxPath(lookup.reverse, walkInstancePath(call.path, lookup.caller));
		}
		case "ts-import": {
			const base = walkInstancePath(call.base, lookup.caller);
			return resolveRbxPath(
				lookup.reverse,
				base === undefined ? undefined : [...base, ...call.segments],
			);
		}
		case "ts-package": {
			return findPackageModule(call.segments, lookup);
		}
	}
}
