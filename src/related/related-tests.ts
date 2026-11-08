import type { CstSuccess, StringRequireResolver } from "@isentinel/luau-ast";
import { createStringRequireResolver, forEachCstNode, readRequireCall } from "@isentinel/luau-ast";
import type { LuauParser } from "@isentinel/luau-ast/parser";

import * as path from "node:path";

import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";

/** Inputs of {@link createRelatedFileFilter}. */
export interface RelatedFileFilterOptions {
	/** File system the Luau modules are read from. */
	fileSystem: FileSystem;
	/** Parser that reads each module's requires. */
	parser: LuauParser;
	/** Absolute paths of the source files the run is related to. */
	relatedFiles: ReadonlyArray<string>;
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
	parser: LuauParser;
	resolve: StringRequireResolver;
}

const LUAU_MODULE = /\.luau?$/;

/**
 * Build the test filter of a Partial Run over `related <files...>`. Each call
 * builds the dependency graph from the given test files through their string
 * requires, then walks it in reverse from each related file and keeps every
 * test file the walk reaches. A test file that is itself related reaches
 * itself. A module read in one call is not read again in the next.
 *
 * @param options - File system, parser, related files and profiler.
 * @returns A function from test files to the ones that reach a related file.
 */
export function createRelatedFileFilter({
	fileSystem,
	parser,
	relatedFiles,
	timing,
}: RelatedFileFilterOptions): RelatedFileFilter {
	const dependenciesOf = createDependencyReader({ fileSystem, parser });
	const relatedKeys = relatedFiles.map((file) => normalizeWindowsPath(file));

	return (testFiles, rootDirectory) => {
		function keyOf(file: string): string {
			return normalizeWindowsPath(path.resolve(rootDirectory, file));
		}

		const reached = timing.profile("buildDependencyGraph", () => {
			const dependents = collectDependents(testFiles.map(keyOf), dependenciesOf);
			return walkDependents(relatedKeys, dependents);
		});
		return testFiles.filter((file) => reached.has(keyOf(file)));
	};
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

function readDependencies(reader: ModuleReader, file: string): ReadonlySet<string> {
	const dependencies = new Set<string>();
	forEachCstNode(parseModule(reader, file), (node) => {
		const call = node.type === "Call" ? readRequireCall(node) : undefined;
		if (call?.kind !== "string") {
			return;
		}

		const resolved = reader.resolve(file, call.path);
		if (resolved.kind === "resolved") {
			dependencies.add(normalizeWindowsPath(resolved.path));
		}
	});
	return dependencies;
}

function createDependencyReader({
	fileSystem,
	parser,
}: Pick<ModuleReader, "fileSystem" | "parser">): (file: string) => ReadonlySet<string> {
	const reader = {
		fileSystem,
		parser,
		resolve: createStringRequireResolver({ fileSystem, parser }),
	} satisfies ModuleReader;
	const cache = new Map<string, ReadonlySet<string>>();
	return (file) => {
		let dependencies = cache.get(file);
		if (dependencies === undefined) {
			dependencies = readDependencies(reader, file);
			cache.set(file, dependencies);
		}

		return dependencies;
	};
}

function collectDependents(
	roots: ReadonlyArray<string>,
	dependenciesOf: (file: string) => ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
	const dependents = new Map<string, Set<string>>();
	const visited = new Set(roots);
	const pending = [...roots];
	for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
		for (const dependency of dependenciesOf(file)) {
			let known = dependents.get(dependency);
			if (known === undefined) {
				known = new Set();
				dependents.set(dependency, known);
			}

			known.add(file);
			if (!visited.has(dependency)) {
				visited.add(dependency);
				pending.push(dependency);
			}
		}
	}

	return dependents;
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
