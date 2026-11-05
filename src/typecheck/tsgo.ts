import { type } from "arktype";
import { parseJSONC } from "confbox";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { nodeFileSystem } from "../utils/file-system.ts";
import type { CheckerSpawnOptions, TypecheckOptions } from "./runner.ts";
import { spawnCheckerAsync } from "./spawn-checker.ts";

const MISSING_TSGO_MESSAGE =
	"Type tests need TypeScript 7 ('typescript' 7+, or '@typescript/native' " +
	"beside TypeScript 6), an optional peer dependency that is not installed.";

const MISSING_TSGO_HINT =
	"npm install -D typescript@7 — or run without --typecheck/--typecheckOnly.";

// TypeScript's advice for running 7 beside 6 aliases 7 as `@typescript/native`;
// `@typescript/native-preview` is the nightly package 7 replaced.
const TSGO_PACKAGES = [
	{ name: "@typescript/native", bin: "tsc" },
	{ name: "typescript", bin: "tsc" },
	{ name: "@typescript/native-preview", bin: "tsgo" },
] as const;

// The manifest's `bin` field is the only stable name for the compiler script.
const tsgoManifestSchema = type({
	"bin?": { "[string]": "string > 0" },
	"version": "string",
});

const compositeTsconfigSchema = type({
	"compilerOptions?": {
		"composite?": "boolean",
	},
});
/**
 * Async so the CPU-bound tsgo subprocess overlaps the network-bound Roblox run
 * (the host event loop stays free to drive the Open Cloud upload/poll while
 * tsgo compiles). Two distinct guards keep the awaited pass from hanging: a
 * launch timer (`spawnTimeout`, cleared on the child `spawn` event) bounds
 * startup, and `execFile`'s own `timeout` (`options.timeout`, the run-level
 * deadline) bounds the compile.
 * @param options - The project, tsconfig, timeouts and spawner.
 * @returns The compiler's output.
 * @rejects {ConfigError} When no TypeScript 7 tsgo is installed.
 * @rejects When tsgo fails to start or times out.
 */
export async function spawnTsgoAsync(options: CheckerSpawnOptions): Promise<string> {
	const { childProcess, fileSystem = nodeFileSystem, runTimeout, spawnTimeout } = options;
	const isComposite = isCompositeProject({
		fileSystem,
		rootDirectory: options.rootDir,
		tsconfig: options.tsconfig,
	});
	const args = buildTsgoArgs(options, isComposite);
	const tsgoScript = resolveTsgoScript(options.resolveModule ?? defaultResolveModule, fileSystem);
	return spawnCheckerAsync({
		args: [tsgoScript, ...args],
		childProcess,
		command: process.execPath,
		cwd: options.rootDir,
		label: "tsgo",
		runTimeout,
		spawnTimeout,
	});
}

function isCompositeProject({
	fileSystem = nodeFileSystem,
	rootDirectory,
	tsconfig,
}: {
	fileSystem?: FileSystem;
	rootDirectory: string;
	tsconfig?: string | undefined;
}): boolean {
	const tsconfigPath =
		tsconfig !== undefined
			? path.resolve(rootDirectory, tsconfig)
			: path.join(rootDirectory, "tsconfig.json");

	try {
		const raw = compositeTsconfigSchema.assert(
			parseJSONC(fileSystem.readFileSync(tsconfigPath, "utf-8")),
		);
		return raw.compilerOptions?.composite === true;
	} catch (err) {
		if (tsconfig !== undefined) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`Warning: could not read tsconfig "${tsconfigPath}": ${message}\n`,
			);
		}

		return false;
	}
}

/**
 * CJS resolution off this module — the only thing here that needs it.
 * @param specifier - The package specifier to resolve.
 * @returns The resolved file path.
 */
function defaultResolveModule(specifier: string): string {
	return createRequire(import.meta.url).resolve(specifier);
}

/**
 * TypeScript 7 is an optional peer dependency, so its absence is an ordinary
 * state to report rather than a broken install — `require.resolve` only raises
 * a bare `MODULE_NOT_FOUND`, which reads as a fault inside the CLI. `ConfigError`
 * matches `assertTypecheckAvailable` (`typecheck-groups.ts`), which rejects
 * TypeScript Type Tests under the standalone binary, and puts the install
 * command in the banner's `Hint:` slot.
 * @param resolveModule - Resolves a package specifier to a path.
 * @param packageName - The package whose manifest to find.
 * @returns The manifest path, or `undefined` when the package is absent.
 * @throws {unknown} Any resolution failure other than `MODULE_NOT_FOUND`.
 */
function resolveManifest(
	resolveModule: (specifier: string) => string,
	packageName: string,
): string | undefined {
	try {
		return resolveModule(`${packageName}/package.json`);
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "MODULE_NOT_FOUND") {
			return undefined;
		}

		throw err;
	}
}

function resolveTsgoScript(
	resolveModule: (specifier: string) => string,
	fileSystem: FileSystem,
): string {
	for (const { name, bin: binName } of TSGO_PACKAGES) {
		const packageJsonPath = resolveManifest(resolveModule, name);
		if (packageJsonPath === undefined) {
			continue;
		}

		const { bin, version } = tsgoManifestSchema.assert(
			JSON.parse(fileSystem.readFileSync(packageJsonPath, "utf-8")),
		);
		const script = bin?.[binName];
		if (script !== undefined && Number.parseInt(version, 10) >= 7) {
			return path.join(path.dirname(packageJsonPath), script);
		}
	}

	throw new ConfigError(MISSING_TSGO_MESSAGE, MISSING_TSGO_HINT);
}

/**
 * A composite project must be driven through `--build` (and emit declarations
 * so downstream references resolve); a plain one type-checks with `--noEmit`.
 * The two also take the tsconfig differently: `--build` accepts it positionally,
 * while a plain run needs `-p`.
 * @param options - The pass options, for the tsconfig.
 * @param isComposite - Whether the tsconfig declares `composite`.
 * @returns The tsgo arguments.
 */
function buildTsgoArgs(options: TypecheckOptions, isComposite: boolean): Array<string> {
	const args: Array<string> = [];

	if (isComposite) {
		args.push("--build", "--emitDeclarationOnly");
	} else {
		args.push("--noEmit");
	}

	args.push("--pretty", "false");

	if (options.tsconfig !== undefined) {
		const resolvedTsconfig = path.resolve(options.rootDir, options.tsconfig);
		if (isComposite) {
			args.push(resolvedTsconfig);
		} else {
			args.push("-p", resolvedTsconfig);
		}
	}

	return args;
}
