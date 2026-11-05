import * as path from "node:path";

import type { JestResult } from "../types/jest-result-types.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import { nodeChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { collectTestDefinitions } from "./collect.ts";
import { createLocationsIndexMap, type FileInfo, mapErrorsToTests } from "./error-mapping.ts";
import { spawnLuauCheckAsync } from "./luau-check.ts";
import { collectLuauTestDefinitions } from "./luau-collect.ts";
import { parseLuauOutput } from "./luau-parse.ts";
import { parseTscOutput } from "./parse.ts";
import { DEFAULT_RUN_TIMEOUT, DEFAULT_SPAWN_TIMEOUT } from "./spawn-checker.ts";
import { spawnTsgoAsync } from "./tsgo.ts";
import { isLuauTypeTestFile } from "./type-test-pattern.ts";
import type { CollectedFile, RawErrorsMap } from "./typecheck-types.ts";

/** Inputs for one type-test pass. */
export interface TypecheckOptions {
	/** What launches the checker. Defaults to the real launcher. */
	childProcess?: ChildProcessRunner;
	/** The type-test files to check; empty runs tsgo over the project. */
	files: Array<string>;
	/**
	 * Where the type-test sources are read. Defaults to the real filesystem.
	 */
	fileSystem?: FileSystem;
	/**
	 * When `false` (default), checker errors in non-test source files surface
	 * as source-level failures. When `true`, only errors inside the discovered
	 * Type Test files are reported.
	 */
	ignoreSourceErrors?: boolean | undefined;
	/**
	 * How a package specifier becomes a path. Defaults to CJS resolution off
	 * this module, which is the only thing that reads `node:module` here.
	 */
	resolveModule?: (specifier: string) => string;
	/** The project root; diagnostics are keyed relative to it. */
	rootDir: string;
	/**
	 * Milliseconds to wait for the checker process to launch before the pass
	 * throws. The timer is cleared the instant the checker reports it spawned;
	 * it does not bound the run. Defaults to {@link DEFAULT_SPAWN_TIMEOUT}.
	 */
	spawnTimeout?: number | undefined;
	/**
	 * Milliseconds the checker *run* may take before it is killed and the pass
	 * throws. The run-level `timeout`. Defaults to {@link DEFAULT_RUN_TIMEOUT}.
	 */
	timeout?: number | undefined;
	/** The tsconfig tsgo checks against. */
	tsconfig?: string | undefined;
}

/** {@link TypecheckOptions} with the defaults a checker needs applied. */
export type CheckerSpawnOptions = TypecheckOptions & {
	/** What launches the checker. */
	childProcess: ChildProcessRunner;
	/** Milliseconds the checker may run before it is killed. */
	runTimeout: number;
	/** Milliseconds the checker may take to start. */
	spawnTimeout: number;
};
// cspell:ignore tsgo
/** The signature of {@link runTypecheckAsync}, for injection. */
export type RunTypecheck = typeof runTypecheckAsync;

interface TypeChecker {
	collect: (source: string, filePath: string) => CollectedFile;
	parse: (output: string) => RawErrorsMap;
	spawn: (options: CheckerSpawnOptions) => Promise<string>;
}

interface CheckerRun {
	checker: TypeChecker;
	checkerFiles: Array<string>;
	output: string;
}
/**
 * Run tsgo and `lute check` over the type-test files and map their errors
 * onto the tests.
 * @param options - The files, project root and checker settings.
 * @returns A Jest result with one case per Type Test.
 * @rejects When a checker fails to start or times out.
 */
export async function runTypecheckAsync(options: TypecheckOptions): Promise<JestResult> {
	const { fileSystem = nodeFileSystem } = options;
	const startTime = Date.now();

	const outputs = await runCheckersAsync(options);

	const files = new Map<string, FileInfo>();
	const resolvedErrors: RawErrorsMap = new Map();
	for (const run of outputs) {
		appendErrors(resolvedErrors, collectCheckerRun({ files, fileSystem, options, run }));
	}

	return mapErrorsToTests({
		errors: resolvedErrors,
		files,
		ignoreSourceErrors: options.ignoreSourceErrors,
		startTime,
	});
}

function appendErrors(errors: RawErrorsMap, additions: RawErrorsMap): void {
	for (const [key, errorList] of additions) {
		errors.set(key, [...(errors.get(key) ?? []), ...errorList]);
	}
}

function relativeKey(rootDirectory: string, filePath: string): string {
	return normalizeWindowsPath(
		path.relative(rootDirectory, path.resolve(rootDirectory, filePath)),
	);
}

function collectCheckerRun({
	files,
	fileSystem,
	options,
	run: { checker, checkerFiles, output },
}: {
	files: Map<string, FileInfo>;
	fileSystem: FileSystem;
	options: TypecheckOptions;
	run: CheckerRun;
}): RawErrorsMap {
	const checkerErrors: RawErrorsMap = new Map();
	for (const [errorPath, errorList] of checker.parse(output)) {
		appendErrors(
			checkerErrors,
			new Map([[relativeKey(options.rootDir, errorPath), errorList]]),
		);
	}

	for (const filePath of checkerFiles) {
		const source = fileSystem.readFileSync(filePath, "utf-8");
		const key = normalizeWindowsPath(path.relative(options.rootDir, path.resolve(filePath)));
		const { definitions, locations, resolve } = checker.collect(source, key);
		files.set(key, { definitions, locations });
		checkerErrors.set(key, resolve(checkerErrors.get(key) ?? []));
	}

	return checkerErrors;
}

function selectTypeChecker(filePath: string): TypeChecker {
	return isLuauTypeTestFile(filePath) ? LUAU_CHECKER : TS_CHECKER;
}

async function runCheckersAsync(options: TypecheckOptions): Promise<Array<CheckerRun>> {
	const spawnOptions = {
		...options,
		childProcess: options.childProcess ?? nodeChildProcessRunner,
		runTimeout: options.timeout ?? DEFAULT_RUN_TIMEOUT,
		spawnTimeout: options.spawnTimeout ?? DEFAULT_SPAWN_TIMEOUT,
	};
	const filesByChecker: Map<TypeChecker, Array<string>> = options.files.length > 0
		? Map.groupBy(options.files, selectTypeChecker)
		: new Map([[TS_CHECKER, []]]);

	return Promise.all(
		Array.from(filesByChecker, async ([checker, checkerFiles]) => {
			return {
				checker,
				checkerFiles,
				output: await checker.spawn({ ...spawnOptions, files: checkerFiles }),
			};
		}),
	);
}

const TS_CHECKER: TypeChecker = {
	collect: (source) => {
		return {
			definitions: collectTestDefinitions(source),
			locations: createLocationsIndexMap(source),
			resolve: (diagnostics) => diagnostics,
		};
	},
	parse: parseTscOutput,
	spawn: spawnTsgoAsync,
};

const LUAU_CHECKER: TypeChecker = {
	collect: collectLuauTestDefinitions,
	parse: parseLuauOutput,
	spawn: spawnLuauCheckAsync,
};
