import type { LuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";

import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TsconfigReader } from "../tsconfig/tsconfig-mappings.ts";
import { isTsSource } from "../utils/extensions.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { dropDriveLetter, normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import type { ChangeKind, ChangeScope } from "./change-scope.ts";
import { classifyChange } from "./change-scope.ts";
import type { LuauOutputResolver } from "./luau-output.ts";
import { createLuauOutputResolver } from "./luau-output.ts";
import type { DependencyReader } from "./module-dependencies.ts";
import { createReaderCache } from "./module-dependencies.ts";

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
	/** Reader of the tsconfig that maps a `.ts` file to its Luau module. */
	tsconfigReader: TsconfigReader;
}

/**
 * Keeps the test files that reach a related file. Each file is absolute or
 * relative to the project root, and comes back in the form it was given.
 */
export type RelatedFileFilter = (
	testFiles: Array<string>,
	project: RelatedProject,
) => Array<string>;

/** The project whose test files one filter call selects from. */
interface RelatedProject {
	/** Absolute path of the project's Rojo project file, if it has one. */
	rojoProjectPath: string | undefined;
	/** Project root the test files are relative to. */
	rootDirectory: string;
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

interface ChangeContext {
	keyOf: (file: string) => string;
	outputOf: LuauOutputResolver;
	scope: ChangeScope | undefined;
}

const EVERY_TEST = "every";

/**
 * Build the test filter of a Partial Run over `related <files...>`. Each call
 * builds the dependency graph from the given test files through their string,
 * instance-path and `TS.import` requires, then walks it in reverse from each
 * related file and keeps every test file the walk reaches. A test file that is
 * itself related reaches itself. A `.ts` file stands for its compiled Luau
 * module, and modules are keyed by real path. A related Luau module that is
 * gone from disk still resolves through a string require, so a deleted module
 * selects every test that required it, unless the require now finds another
 * form of it on disk, as after `x.lua` moves to `x.luau`. A module read in one
 * call is not read again in the next.
 *
 * The filter keeps every test file when it cannot be sure: a related file
 * matches `forceRerunTriggers`, or is an Opaque Change, or the graph holds a
 * module it cannot read or a require it cannot follow while any related file
 * is in scope. A related `.ts` file with no Luau module is classified as
 * itself. A related file outside the scope and the graph is ignored.
 *
 * @param options - File system, parser, related files, scope, profiler and
 *   tsconfig reader.
 * @returns A function from test files to the ones that reach a related file.
 */
export function createRelatedFileFilter({
	fileSystem,
	parser,
	relatedFiles,
	scope,
	timing,
	tsconfigReader,
}: RelatedFileFilterOptions): RelatedFileFilter {
	const outputOf = memoize(createLuauOutputResolver({ fileSystem, tsconfigReader }));
	const keyOf = memoize((file: string) => toModuleKey(fileSystem, file));
	const readerOf = createReaderCache({
		fileSystem,
		parser,
		relatedKeys: relatedFiles.map((file) => normalizeWindowsPath(file)),
	});
	const changes = relatedFiles.map((file) => toChange({ keyOf, outputOf, scope }, file));

	return (testFiles, { rojoProjectPath, rootDirectory }) => {
		function rootOf(file: string): string {
			return toRoot({ file, outputOf, rootDirectory });
		}

		const reached = timing.profile("buildDependencyGraph", () => {
			const graph = collectGraph({
				dependenciesOf: readerOf(rojoProjectPath),
				keyOf,
				roots: testFiles.map(rootOf),
			});
			return selectReached(
				changes,
				scope === undefined ? { ...graph, isOpen: false } : graph,
			);
		});
		return reached === EVERY_TEST
			? testFiles
			: testFiles.filter((file) => reached.has(keyOf(rootOf(file))));
	};
}

function toRoot({
	file,
	outputOf,
	rootDirectory,
}: {
	file: string;
	outputOf: LuauOutputResolver;
	rootDirectory: string;
}): string {
	const absolute = normalizeWindowsPath(path.resolve(rootDirectory, file));
	const module = isTsSource(absolute) ? outputOf(absolute) : undefined;
	return module === undefined ? absolute : normalizeWindowsPath(module);
}

function toChange({ keyOf, outputOf, scope }: ChangeContext, file: string): Change {
	const module = isTsSource(file) ? outputOf(file) : undefined;
	const key = keyOf(module ?? file);
	if (scope === undefined) {
		return { key, kind: "module" };
	}

	const kind = classifyChange(scope, normalizeWindowsPath(file));
	return {
		key,
		kind:
			kind === "trigger" || module === undefined
				? kind
				: classifyChange(scope, normalizeWindowsPath(module)),
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

function memoize<T>(compute: (file: string) => T): (file: string) => T {
	const cache = new Map<string, { value: T }>();
	return (file) => {
		let entry = cache.get(file);
		if (entry === undefined) {
			entry = { value: compute(file) };
			cache.set(file, entry);
		}

		return entry.value;
	};
}

function toModuleKey(fileSystem: FileSystem, file: string): string {
	const absolute = path.resolve(file);
	const real = fileSystem.existsSync(absolute) ? fileSystem.realpathSync(absolute) : absolute;
	return dropDriveLetter(normalizeWindowsPath(real));
}

function collectGraph({
	dependenciesOf,
	keyOf,
	roots,
}: {
	dependenciesOf: DependencyReader;
	keyOf: (file: string) => string;
	roots: ReadonlyArray<string>;
}): DependencyGraph {
	const dependents = new Map<string, Set<string>>();
	const modules = new Set(roots.map(keyOf));
	const visited = new Set(roots);
	const pending = [...roots];
	let isOpen = false;
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		const fileKey = keyOf(file);
		const read = dependenciesOf(file);
		isOpen ||= read.isOpen;
		for (const dependency of read.dependencies) {
			const dependencyKey = keyOf(dependency);
			let known = dependents.get(dependencyKey);
			if (known === undefined) {
				known = new Set();
				dependents.set(dependencyKey, known);
			}

			known.add(fileKey);
			modules.add(dependencyKey);
			if (!visited.has(dependency)) {
				visited.add(dependency);
				pending.push(dependency);
			}
		}
	}

	return { dependents, isOpen, modules };
}
