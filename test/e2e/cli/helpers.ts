import { Buffer } from "node:buffer";
import { execFile, execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import nodeProcess from "node:process";
import { onTestFinished } from "vitest";

interface ExecResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface RunCliOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
}

const BIN = path.resolve(__dirname, "../../../bin/jest-roblox.js");

// cspell:ignore LOCALAPPDATA MSYSTEM PATHEXT PROGRAMDATA WINDIR
const ALLOWED_ENV_VARS = [
	"APPDATA",
	"CI",
	"ComSpec",
	"HOME",
	"LOCALAPPDATA",
	"MSYSTEM",
	"NODE_OPTIONS",
	"NUMBER_OF_PROCESSORS",
	"PATH",
	"PATHEXT",
	"PNPM_HOME",
	"PROGRAMDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TERM",
	"TMP",
	"USERPROFILE",
	"WINDIR",
] as const;

export function runCli(args: Array<string>, cwdOrOptions?: RunCliOptions | string): ExecResult {
	const options = typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : (cwdOrOptions ?? {});

	try {
		const stdout = execFileSync("node", [BIN, ...args], {
			cwd: options.cwd,
			encoding: "utf-8",
			env: buildCliEnvironment(options.env),
			timeout: options.timeoutMs ?? 30_000,
		});
		return { exitCode: 0, stderr: "", stdout };
	} catch (err: unknown) {
		return {
			exitCode: getProperty(err, "status", 1),
			stderr: normalizeOutput(getProperty(err, "stderr", "")),
			stdout: normalizeOutput(getProperty(err, "stdout", "")),
		};
	}
}

export async function runCliAsync(
	args: Array<string>,
	cwdOrOptions?: RunCliOptions | string,
): Promise<ExecResult> {
	const options = typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : (cwdOrOptions ?? {});

	return new Promise((resolve) => {
		execFile(
			"node",
			[BIN, ...args],
			{
				cwd: options.cwd,
				encoding: "utf-8",
				env: buildCliEnvironment(options.env),
				maxBuffer: 16 * 1024 * 1024,
				timeout: options.timeoutMs ?? 30_000,
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ exitCode: 0, stderr, stdout });
					return;
				}

				const status = "code" in error ? error.code : undefined;

				resolve({
					exitCode: typeof status === "number" ? status : 1,
					stderr,
					stdout,
				});
			},
		);
	});
}

export function readJsonSync(filePath: string): unknown {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

export function createFixtureSandbox(sourcePath: string): string {
	const sandboxRoot = path.resolve(__dirname, ".tmp");
	mkdirSync(sandboxRoot, { recursive: true });
	const directory = mkdtempSync(path.join(sandboxRoot, "jest-roblox-cli-e2e-"));
	const sandboxPath = path.join(directory, path.basename(sourcePath));
	cpSync(sourcePath, sandboxPath, { recursive: true });
	absolutizeEscapingProjectPaths(sourcePath, sandboxPath);
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return sandboxPath;
}

export function createRbxtsFixtureSandbox(sourcePath: string): string {
	const sandboxPath = createFixtureSandbox(sourcePath);
	const outDirectory = path.join(sandboxPath, "out");

	mkdirSync(outDirectory, { recursive: true });
	writeFileSync(path.join(sandboxPath, "game.rbxl"), Buffer.from("fake-rbxl-place", "utf-8"));
	writeFileSync(path.join(outDirectory, "example.luau"), RBXTS_EXAMPLE_LUAU);
	writeFileSync(path.join(outDirectory, "example.luau.map"), RBXTS_EXAMPLE_LUAU_MAP);
	writeFileSync(path.join(outDirectory, "example.spec.luau"), RBXTS_EXAMPLE_SPEC_LUAU);
	writeFileSync(path.join(outDirectory, "example.spec.luau.map"), RBXTS_EXAMPLE_SPEC_LUAU_MAP);
	writeFileSync(
		path.join(outDirectory, "example.d.ts"),
		"export declare function greet(name: string): string;\nexport declare function add(a: number, b: number): number;\n",
	);
	writeFileSync(path.join(outDirectory, "example.spec.d.ts"), "export {};\n");
	writeFileSync(path.join(outDirectory, "jest.config.luau"), RBXTS_JEST_CONFIG_LUAU);

	return sandboxPath;
}

function rewriteEscapingPaths(
	node: unknown,
	sourceResolved: string,
	sandboxResolved: string,
): void {
	if (node === null || typeof node !== "object") {
		return;
	}

	const record = node as Record<string, unknown>;
	const value = record["$path"];
	if (typeof value === "string" && !path.isAbsolute(value)) {
		const absolute = path.resolve(sourceResolved, value);
		const relativeFromSource = path.relative(sourceResolved, absolute);
		if (relativeFromSource.startsWith("..") || path.isAbsolute(relativeFromSource)) {
			const fromSandbox = path.relative(sandboxResolved, absolute).replaceAll("\\", "/");
			record["$path"] = fromSandbox;
		}
	}

	for (const child of Object.values(record)) {
		rewriteEscapingPaths(child, sourceResolved, sandboxResolved);
	}
}

// Rojo project files use `$path` values relative to the project file. When a
// fixture references siblings outside its own directory (e.g. `rojo-sync/`),
// the relative path is calibrated to the fixture's location in the repo —
// copying the fixture to a temp sandbox at a different depth breaks those
// references. For each `$path` that escapes the source fixture, rewrite it
// to a sandbox-relative path that points back at the original target.
// Sandbox-relative (rather than absolute) lets downstream consumers like the
// coverage rewriter still relocate the project tree without mangling the path.
function absolutizeEscapingProjectPaths(sourceDirectory: string, sandboxDirectory: string): void {
	const projectFile = path.join(sandboxDirectory, "default.project.json");
	if (!existsSync(projectFile)) {
		return;
	}

	const sourceResolved = path.resolve(sourceDirectory);
	const sandboxResolved = path.resolve(sandboxDirectory);
	const raw: unknown = JSON.parse(readFileSync(projectFile, "utf-8"));

	rewriteEscapingPaths(raw, sourceResolved, sandboxResolved);
	writeFileSync(projectFile, `${JSON.stringify(raw, null, "\t")}\n`);
}

const RBXTS_EXAMPLE_LUAU = `-- Compiled with @isentinel/roblox-ts v3.1.5
local function greet(name)
	return \`hello {name}\`
end
local function add(a, b)
	return a + b
end
return {
	greet = greet,
	add = add,
}
`;

// cspell:ignore AACC AACD AAEA AACA
const RBXTS_EXAMPLE_LUAU_MAP = JSON.stringify({
	file: "example.luau",
	ignoreList: [],
	mappings: ";AAAA;AACC;AACD;AAEA;AACC;AACD",
	names: [],
	sources: ["../src/example.ts"],
	sourcesContent: [
		"export function greet(name: string): string {\n\treturn `hello ${" +
			"name}`;\n}\n\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
	],
	version: 3,
});

const RBXTS_EXAMPLE_SPEC_LUAU = `-- Compiled with @isentinel/roblox-ts v3.1.5
local TS = _G[script]
local _example = TS.import(script, script.Parent, "example")
local add = _example.add
local greet = _example.greet
local result = greet("Alice")
print(result)
local sum = add(2, 3)
print(sum)
`;

const RBXTS_EXAMPLE_SPEC_LUAU_MAP = JSON.stringify({
	file: "example.spec.luau",
	ignoreList: [],
	mappings: ";;AAAA;AAAA;AAAA;AAEA;AACA;AAEA;AACA",
	names: [],
	sources: ["../src/example.spec.ts"],
	sourcesContent: [
		'import { add, greet } from "./example";\n\nconst result = greet("Alice");\nprint(result);\n\nconst sum = add(2, 3);\nprint(sum);\n',
	],
	version: 3,
});

const RBXTS_JEST_CONFIG_LUAU = `-- Auto-generated by jest-roblox (do not edit)
return {
	color = true,
	passWithNoTests = true,
	silent = false,
	testMatch = { "**/*.spec" },
	testPathIgnorePatterns = { "/node_modules/", "/dist/", "/out/" },
	verbose = false,
	displayName = "rbxts-e2e",
}
`;

function getProperty<T>(error: unknown, key: string, fallback: T): T {
	if (typeof error === "object" && error !== null && key in error) {
		return (error as Record<string, unknown>)[key] as T;
	}

	return fallback;
}

function buildCliEnvironment(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { FORCE_COLOR: "0", NO_COLOR: "1" };

	for (const key of ALLOWED_ENV_VARS) {
		const value = nodeProcess.env[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}

	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete environment[key];
		} else {
			environment[key] = value;
		}
	}

	return environment;
}

function normalizeOutput(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (Buffer.isBuffer(value)) {
		return value.toString("utf-8");
	}

	return "";
}
