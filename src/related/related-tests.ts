import type { CstSuccess, RequireFileSystem, StringRequireResolver } from "@isentinel/luau-ast";
import { createStringRequireResolver, forEachCstNode, readRequireCall } from "@isentinel/luau-ast";
import type { LuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";

import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ChangeKind, ChangeScope } from "./change-scope.ts";
import { classifyChange } from "./change-scope.ts";

/** Inputs of {@link createRelatedFileFilter}. */
export interface RelatedFileFilterOptions {
	/** File system the Luau modules are read from. */
	fileSystem: FileSystem;
	/** Parser that reads each module's requires. */
	parser: LuauParser;
	/** Absolute paths of the source files the run is related to. */
	relatedFiles: ReadonlyArray<string>;
	/**
	 * Roots and triggers the related files are classified against. Without
	 * one, every related file starts the walk and the run never widens.
	 */
	scope?: ChangeScope | undefined;
	/** Profiler the graph build reports its phase to. */
	timing: TimingCollector;
}

/**
 * Keeps the test files that reach a related file. Each file is absolute or
 * relative to `rootDirectory`, and comes back in the form it was given.
 */
export type RelatedFileFilter = (testFiles: Array<string>, rootDirectory: string) => Array<string>;

interface ModuleReader {
	fileSystem: FileSystem;
	isDeletedModule: (file: string) => boolean;
	parser: LuauParser;
	resolve: StringRequireResolver;
}

interface ModuleDependencies {
	dependencies: ReadonlySet<string>;
	isOpen: boolean;
}

interface DependencyGraph {
	dependents: ReadonlyMap<string, ReadonlySet<string>>;
	isOpen: boolean;
	modules: ReadonlySet<string>;
}

interface Change {
	key: string;
	kind: ChangeKind;
}

const EVERY_TEST = "every";

// Mirror luau-ast's require resolver: its module probes, and the alias config
// names it reads as config, not as modules.
const LUAU_MODULE = /\.luau?$/;
const MODULE_FORM = /(?:\/init)?\.luau?$/;
const MODULE_FORMS = [".luau", ".lua", "/init.luau", "/init.lua"];
const REQUIRE_CONFIG = ".config.luau";

/**
 * Build the test filter of a Partial Run over `related <files...>`. Each call
 * builds the dependency graph from the given test files through their string
 * requires, then walks it in reverse from each related file and keeps every
 * test file the walk reaches. A test file that is itself related reaches
 * itself. A related Luau module that is gone from disk still resolves, so a
 * deleted module selects every test that required it, unless the require now
 * finds another form of it on disk, as after `x.lua` moves to `x.luau`. A
 * module read in one call is not read again in the next.
 *
 * The filter keeps every test file when it cannot be sure: a related file
 * matches `forceRerunTriggers`, or is an Opaque Change, or the graph holds a
 * module it cannot read or a require it cannot follow while any related file
 * is in scope. A related file outside the scope and the graph is ignored.
 *
 * @param options - File system, parser, related files, scope and profiler.
 * @returns A function from test files to the ones that reach a related file.
 */
export function createRelatedFileFilter({
	fileSystem,
	parser,
	relatedFiles,
	scope,
	timing,
}: RelatedFileFilterOptions): RelatedFileFilter {
	const relatedKeys = relatedFiles.map((file) => normalizeWindowsPath(file));
	const dependenciesOf = createDependencyReader({ fileSystem, parser, relatedKeys });
	const changes = relatedKeys.map((key) => {
		return {
			key,
			kind: scope === undefined ? "module" : classifyChange(scope, key),
		} satisfies Change;
	});

	return (testFiles, rootDirectory) => {
		function keyOf(file: string): string {
			return normalizeWindowsPath(path.resolve(rootDirectory, file));
		}

		const reached = timing.profile("buildDependencyGraph", () => {
			const graph = collectGraph(testFiles.map(keyOf), dependenciesOf);
			return selectReached(
				changes,
				scope === undefined ? { ...graph, isOpen: false } : graph,
			);
		});
		return reached === EVERY_TEST
			? testFiles
			: testFiles.filter((file) => reached.has(keyOf(file)));
	};
}

function walkDependents(
	starts: ReadonlyArray<string>,
	dependents: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
	const reached = new Set(starts);
	const pending = [...starts];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		const fileDependents = dependents.get(file) ?? new Set<string>();
		const unreached = [...fileDependents].filter((dependent) => !reached.has(dependent));
		for (const dependent of unreached) {
			reached.add(dependent);
			pending.push(dependent);
		}
	}

	return reached;
}

function selectReached(
	changes: ReadonlyArray<Change>,
	graph: DependencyGraph,
): ReadonlySet<string> | typeof EVERY_TEST {
	const starts: Array<string> = [];
	for (const { key, kind } of changes) {
		const isModule = graph.modules.has(key);
		if (kind === "trigger" || (kind === "opaque" && !isModule)) {
			return EVERY_TEST;
		}

		if (isModule || kind === "module") {
			starts.push(key);
		}
	}

	if (starts.length > 0 && graph.isOpen) {
		return EVERY_TEST;
	}

	return walkDependents(starts, graph.dependents);
}

function parseModule(
	{ fileSystem, parser }: ModuleReader,
	file: string,
): CstSuccess["root"] | undefined {
	if (!LUAU_MODULE.test(file) || !fileSystem.existsSync(file)) {
		return undefined;
	}

	const parsed = parser.parseCst({
		fileName: file,
		source: fileSystem.readFileSync(file, "utf-8"),
	});
	return parsed.ok ? parsed.root : undefined;
}

function readDependencies(reader: ModuleReader, file: string): ModuleDependencies {
	if (reader.isDeletedModule(file)) {
		return { dependencies: new Set(), isOpen: false };
	}

	const root = parseModule(reader, file);
	const dependencies = new Set<string>();
	let isOpen = root === undefined;
	forEachCstNode(root, (node) => {
		const call = node.type === "Call" ? readRequireCall(node) : undefined;
		if (call === undefined) {
			return;
		}

		const resolved = call.kind === "string" ? reader.resolve(file, call.path) : undefined;
		if (resolved?.kind === "resolved") {
			dependencies.add(normalizeWindowsPath(resolved.path));
		} else {
			isOpen = true;
		}
	});
	return { dependencies, isOpen };
}

function createDeletedModuleCheck(
	fileSystem: FileSystem,
	relatedKeys: ReadonlyArray<string>,
): (file: string) => boolean {
	const modules = new Set(
		relatedKeys.filter(
			(key) => LUAU_MODULE.test(key) && path.posix.basename(key) !== REQUIRE_CONFIG,
		),
	);
	return (file) => {
		const key = normalizeWindowsPath(file);
		if (!modules.has(key)) {
			return false;
		}

		const target = key.replace(MODULE_FORM, "");
		return MODULE_FORMS.every((form) => !fileSystem.existsSync(target + form));
	};
}

function createDependencyReader({
	fileSystem,
	parser,
	relatedKeys,
}: Pick<ModuleReader, "fileSystem" | "parser"> & {
	relatedKeys: ReadonlyArray<string>;
}): (file: string) => ModuleDependencies {
	const isDeletedModule = createDeletedModuleCheck(fileSystem, relatedKeys);
	const requireFileSystem: RequireFileSystem = {
		existsSync: (file) => fileSystem.existsSync(file) || isDeletedModule(file),
		readFileSync: (file, encoding) => fileSystem.readFileSync(file, encoding),
	};
	const reader = {
		fileSystem,
		isDeletedModule,
		parser,
		resolve: createStringRequireResolver({ fileSystem: requireFileSystem, parser }),
	} satisfies ModuleReader;
	const cache = new Map<string, ModuleDependencies>();
	return (file) => {
		let dependencies = cache.get(file);
		if (dependencies === undefined) {
			dependencies = readDependencies(reader, file);
			cache.set(file, dependencies);
		}

		return dependencies;
	};
}

function collectGraph(
	roots: ReadonlyArray<string>,
	dependenciesOf: (file: string) => ModuleDependencies,
): DependencyGraph {
	const dependents = new Map<string, Set<string>>();
	const modules = new Set(roots);
	const pending = [...roots];
	let isOpen = false;
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		const read = dependenciesOf(file);
		isOpen ||= read.isOpen;
		for (const dependency of read.dependencies) {
			let known = dependents.get(dependency);
			if (known === undefined) {
				known = new Set();
				dependents.set(dependency, known);
			}

			known.add(file);
			if (!modules.has(dependency)) {
				modules.add(dependency);
				pending.push(dependency);
			}
		}
	}

	return { dependents, isOpen, modules };
}
