import type { JestResult } from "@isentinel/jest-roblox/api";

import { type } from "arktype";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import nodeProcess from "node:process";
import { assert, inject, onTestFinished } from "vitest";

import { buildCliEnvironment, hermeticEnvironment } from "#test/harness/cli-environment.ts";
import { absolutizeEscapingProjectPaths } from "#test/harness/project-path-rewrite.ts";
import { writeRbxtsCompiledOutput } from "#test/harness/rbxts-compiled-fixture.ts";
import { createSandboxDirectory } from "#test/harness/sandbox-root.ts";

/** Budget for one CLI run against a fixture sandbox. */
export const RUN_TIMEOUT_MS = 60_000;

export interface JestEnvelopePayload {
	runner: { setup: number };
	success: true;
	value: JestResult;
}

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

const BIN = path.resolve(__dirname, "../../bin/jest-roblox.js");

const SEA_BUNDLE = path.resolve(__dirname, "../../dist/sea/sea-entry.cjs");

const mergedResultSchema = type({ testResults: type({ testFilePath: "string" }).array() });

// runCli passes `encoding: "utf-8"`, so the thrown failure carries the captured
// streams as strings; Buffer would only appear if we dropped that option.
const execFailureSchema = type({
	"status?": "number | null",
	"stderr?": "string",
	"stdout?": "string",
});

export function runCli(args: Array<string>, cwdOrOptions?: RunCliOptions | string): ExecResult {
	const options = normalizeRunOptions(cwdOrOptions);

	try {
		const stdout = execFileSync("node", [BIN, ...withIsolatedBackend(args)], {
			cwd: options.cwd,
			encoding: "utf-8",
			env: buildCliEnvironment(options.env),
			timeout: options.timeoutMs ?? 30_000,
			windowsHide: true,
		});
		return { exitCode: 0, stderr: "", stdout };
	} catch (err) {
		const failure = execFailureSchema(err);
		if (failure instanceof type.errors) {
			throw err;
		}

		return {
			exitCode: failure.status ?? 1,
			stderr: failure.stderr ?? "",
			stdout: failure.stdout ?? "",
		};
	}
}

export async function runCliAsync(
	args: Array<string>,
	cwdOrOptions?: RunCliOptions | string,
): Promise<ExecResult> {
	return execCliAsync({
		args: [BIN, ...withIsolatedBackend(args)],
		command: "node",
		cwdOrOptions,
	});
}

/**
 * Drives the CJS bundle the SEA executable is built from, rather than
 * `bin/jest-roblox.js`, which prefers `src/` and so never loads a bundle at
 * all. Everything the binary carries has to be inside that one file: a
 * dependency reaching for a sibling module or a data file at run time resolves
 * beside the bundle here, and beside the executable there, and neither holds
 * one. Running it under node reproduces that on any machine, in a second,
 * without building a 100 MB binary first.
 * @param args - CLI arguments.
 * @param cwdOrOptions - Working directory, or run options.
 * @returns Exit code and captured output.
 */
export async function runSeaBundleAsync(
	args: Array<string>,
	cwdOrOptions?: RunCliOptions | string,
): Promise<ExecResult> {
	return execCliAsync({
		args: [SEA_BUNDLE, ...withIsolatedBackend(args)],
		command: "node",
		cwdOrOptions,
	});
}

export async function runSeaExecutableAsync(
	args: Array<string>,
	cwdOrOptions?: RunCliOptions | string,
): Promise<ExecResult> {
	const extension = nodeProcess.platform === "win32" ? ".exe" : "";
	const command = path.resolve(__dirname, `../../dist/sea/jest-roblox${extension}`);
	return execCliAsync({ args: withIsolatedBackend(args), command, cwdOrOptions });
}

export function readJsonSync(filePath: string): JSONValue {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Whether rojo can be shelled out to, as the `e2e` global setup probed it.
 * Rojo is the only place builder, so a spec that builds a real place gates on
 * it.
 * @returns Whether `rojo --version` runs.
 */
export function rojoOnPath(): boolean {
	return inject("rojoOnPath");
}

/**
 * The `testFilePath`s of a merged result sink (`--outputFile`), validated
 * against the one field the type-test e2e specs read rather than asserted onto
 * the parsed JSON.
 * @param filePath - Path of the merged result file.
 * @returns Test file paths, in file order.
 */
export function readMergedTestFilePaths(filePath: string): Array<string> {
	const merged = mergedResultSchema.assert(readJsonSync(filePath));
	return merged.testResults.map((file) => file.testFilePath);
}

function normalizeRunOptions(options: RunCliOptions | string | undefined): RunCliOptions {
	return typeof options === "string" ? { cwd: options } : (options ?? {});
}

async function execCliAsync({
	args,
	command,
	cwdOrOptions,
}: {
	args: Array<string>;
	command: string;
	cwdOrOptions: RunCliOptions | string | undefined;
}): Promise<ExecResult> {
	const options = normalizeRunOptions(cwdOrOptions);

	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				encoding: "utf-8",
				env: buildCliEnvironment(options.env),
				maxBuffer: 16 * 1024 * 1024,
				timeout: options.timeoutMs ?? 30_000,
				windowsHide: true,
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

/**
 * What a previous run wrote into a fixture, rather than what the fixture is.
 * The specs that drive the CLI at a fixture path directly (rather than at a
 * sandbox) leave these behind, and they are gitignored, so which of them exist
 * depends on what ran on this machine before.
 *
 * Copying them into a sandbox is how a spec ends up asserting on an artifact
 * it did not produce: `.jest-roblox/cache/<mount>/jest.config.luau` is a
 * generated stub, so a spec that checks the CLI generated one would pass
 * against a stale copy with generation entirely broken.
 */
const FIXTURE_RUN_ARTIFACTS = new Set([".jest-roblox", "coverage"]);

export function createFixtureSandbox(sourcePath: string): string {
	const directory = createSandboxDirectory();
	const sandboxPath = path.join(directory, path.basename(sourcePath));
	cpSync(sourcePath, sandboxPath, {
		filter: (source) => !FIXTURE_RUN_ARTIFACTS.has(path.basename(source)),
		recursive: true,
	});
	absolutizeEscapingProjectPaths({ sandboxDirectory: sandboxPath, sourceDirectory: sourcePath });
	onTestFinished(() => {
		rmSync(directory, { force: true, recursive: true });
	});
	return sandboxPath;
}

/**
 * Prepend config fields to a sandbox's `defineConfig({ … })`, patching the
 * fixture's own config rather than restating it.
 * @param sandbox - Sandbox directory.
 * @param fields - Config fields as source text.
 */
export function patchSandboxConfig(sandbox: string, fields: string): void {
	const configPath = path.join(sandbox, "jest.config.ts");
	const source = readFileSync(configPath, "utf-8");
	const patched = source.replace(
		"defineConfig({",
		() => `defineConfig({
	${fields}`,
	);
	// A patch that matched nothing would run the fixture's own config and fail
	// the spec far from the broken helper.
	assert(patched !== source, "config patch matched nothing in the fixture config");
	writeFileSync(configPath, patched);
}

export function createRbxtsFixtureSandbox(sourcePath: string): string {
	const sandboxPath = createFixtureSandbox(sourcePath);
	writeRbxtsCompiledOutput(sandboxPath);

	return sandboxPath;
}

/**
 * Mixed stdout the Luau runner produces around the Jest JSON payload;
 * exercises `extractJsonFromOutput`'s log-noise stripping.
 * @param payload - Jest payload to embed.
 * @returns Log lines with the payload between them.
 */
export function buildMixedOutput(payload: JestEnvelopePayload): string {
	return [
		"Booting fake Roblox runner",
		JSON.stringify(payload),
		"Finished fake Roblox runner",
	].join("\n");
}

/**
 * A minimal passing single-suite Jest payload in the runner's wire shape.
 * @returns Passing payload with one suite.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Returns a cohesive single object; splitting would scatter the fields and make it harder to see the shape.
export function buildPassingPayload(): JestEnvelopePayload {
	return {
		runner: {
			setup: 0.1,
		},
		success: true,
		value: {
			numFailedTests: 0,
			numPassedTests: 1,
			numPendingTests: 0,
			numTotalTests: 1,
			startTime: 1_710_000_000_000,
			success: true,
			testResults: [
				{
					numFailingTests: 0,
					numPassingTests: 1,
					numPendingTests: 0,
					testFilePath: "ReplicatedStorage/shared/example.spec",
					testResults: [
						{
							ancestorTitles: ["example"],
							duration: 12,
							failureMessages: [],
							fullName: "example greets",
							status: "passed",
							title: "greets",
						},
					],
				},
			],
		},
	};
}

/**
 * The serialized Jest payload a `FakeOpenCloudTask` carries when the run under
 * test only needs the task to succeed. Counts, not results. A spec asserting
 * on pipeline shape reads `1 passed` and the server-side call record, never the
 * suite bodies.
 * @param snapshotWrites - Snapshot files the run reports writing, if any.
 * @returns Serialized Jest output.
 */
export function buildPassingJestOutput(snapshotWrites?: Record<string, string>): string {
	return JSON.stringify({
		...(snapshotWrites === undefined ? {} : { runner: { snapshotWrites } }),
		numFailedTests: 0,
		numPassedTests: 1,
		numPendingTests: 0,
		numTotalTests: 1,
		startTime: 0,
		success: true,
		testResults: [],
	});
}

/**
 * Env vars pointing the CLI's open-cloud backend at a fake server.
 * @param baseUrl - Base URL of the fake server.
 * @returns Environment variables for the CLI.
 */
export function createOpenCloudEnvironment(baseUrl: string): NonNullable<RunCliOptions["env"]> {
	return {
		JEST_ROBLOX_OPEN_CLOUD_BASE_URL: baseUrl,
		ROBLOX_OPEN_CLOUD_API_KEY: "test-api-key",
		ROBLOX_PLACE_ID: "456",
		ROBLOX_UNIVERSE_ID: "123",
	};
}

/**
 * Gate every caller on {@link isStudioOnHost}.
 * @returns Host values of the hermetic environment keys.
 */
export function hostStudioEnvironment(): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.keys(hermeticEnvironment()).map((key) => [key, nodeProcess.env[key]]),
	);
}

/**
 * Whether the built CLI finds a Studio on this host. `--backend auto` prints
 * the backend it resolved before any run starts, and a VM count above any
 * plugin's pool then fails the run on either backend, so nothing launches.
 * @returns `true` when the CLI resolves `auto` to `studio-cli`.
 */
export function isStudioOnHost(): boolean {
	const directory = createSandboxDirectory();
	try {
		mkdirSync(path.join(directory, "src"));
		writeFileSync(path.join(directory, "src", "probe.spec.luau"), "return {}\n");
		writeFileSync(
			path.join(directory, "jest.config.luau"),
			'return { luauRoots = { "src" }, placeFile = "game.rbxl", test = {} }\n',
		);
		const probe = runCli(["--backend", "auto", "--experimental-vm-parallel", "999"], {
			cwd: directory,
			env: hostStudioEnvironment(),
		});
		return probe.stderr.includes("Backend: studio-cli");
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

/**
 * Pins Open Cloud, so auto never launches a local Studio, unless the caller
 * names a `--backend`.
 * @param args - CLI arguments.
 * @returns The arguments, with `--backend open-cloud` first when none is given.
 */
function withIsolatedBackend(args: Array<string>): Array<string> {
	const hasBackend = args.some(
		(argument) => argument === "--backend" || argument.startsWith("--backend="),
	);
	return hasBackend ? args : ["--backend", "open-cloud", ...args];
}
