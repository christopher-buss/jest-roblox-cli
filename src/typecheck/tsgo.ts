import { type } from "arktype";
import { parseJSONC } from "confbox";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";

import { ConfigError } from "../config/errors.ts";
import type { FileSystem } from "../utils/file-system.ts";
import type { CheckerSpawnOptions, TypecheckOptions } from "./runner.ts";
import { spawnCheckerAsync } from "./spawn-checker.ts";

const MISSING_TSGO_MESSAGE =
	"Type tests need TypeScript 7 ('typescript' 7+, or '@typescript/native' " +
	"beside TypeScript 6), an optional peer dependency that is not installed.";

const MISSING_TSGO_HINT =
	"npm install -D typescript@7, or run without --typecheck/--typecheckOnly.";

// TypeScript's advice for running 7 beside 6 aliases 7 as `@typescript/native`;
// `@typescript/native-preview` is the nightly package 7 replaced.
const TSGO_PACKAGES = [
	{ name: "@typescript/native", bin: "tsc" },
	{ name: "typescript", bin: "tsc" },
	{ name: "@typescript/native-preview", bin: "tsgo" },
] as const;

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
 * Spawn tsgo over the project and return its output.
 * @param options - The project, tsconfig, timeouts and spawner.
 * @returns The compiler's output.
 * @rejects {ConfigError} When no TypeScript 7 tsgo is installed.
 * @rejects When tsgo fails to start or times out.
 */
export async function spawnTsgoAsync(options: CheckerSpawnOptions): Promise<string> {
	const { childProcess, fileSystem, runTimeout, spawnTimeout } = options;
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
	fileSystem,
	rootDirectory,
	tsconfig,
}: {
	fileSystem: FileSystem;
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

function defaultResolveModule(specifier: string): string {
	return createRequire(import.meta.url).resolve(specifier);
}

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
