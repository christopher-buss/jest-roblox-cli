import { type } from "arktype";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import { findRojoProject } from "../coverage-pipeline/prepare.ts";
import {
	type BuildPlaceOptions,
	buildPlace as defaultBuildPlace,
} from "../staging/place-builder.ts";
import { buildJestArgv, type JestArgv } from "../test-script.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { parseEnvelope } from "./envelope.ts";
import type {
	Backend,
	BackendOptions,
	BackendResult,
	ProjectJob,
	RawBackendEntry,
} from "./interface.ts";
import { discoverStudioPath } from "./studio-discovery.ts";

const DEFAULT_STUDIO_CLI_TIMEOUT = 300_000;

/** Lowest-precedence Studio-executable override (below config key / CLI flag). */
const STUDIO_PATH_ENV = "JEST_ROBLOX_STUDIO_PATH";

/**
 * Plugin/CLI protocol version, carried in the Run-mode payload. Matches
 * `STUDIO_PROTOCOL_VERSION` in the WebSocket `studio` backend. The rich version
 * handshake (mismatch detection + echo) is a sibling slice; this slice only
 * carries the field forward.
 */
const STUDIO_CLI_PROTOCOL_VERSION = 2;

/**
 * Stable marker the bootstrap brackets the result envelope with so the host can
 * recover it from a `--outputFile` log interleaved with engine/plugin lines.
 */
const RESULT_DELIMITER = "@@JEST_ROBLOX_STUDIO_CLI_RESULT@@";

const BACKEND_NAME = "studio-cli";
const WORK_DIR = path.join(".jest-roblox", BACKEND_NAME);
const PLACE_FILE = "place.rbxl";
const PLACE_PROJECT_FILE = "place.project.json";
const BOOTSTRAP_FILE = "bootstrap.server.luau";
const OUTPUT_FILE = "output.log";

const NO_RESULT_ERROR =
	"studio-cli: no test result was produced. Ensure Roblox Studio launched and " +
	"the jest-roblox Studio plugin is installed.";

const resultWrapperSchema = type({ "gameOutput?": "string", "jestOutput": "string" });

export interface StudioCliLaunchRequest {
	/** Full Studio CLI argument vector (already absolute paths). */
	args: Array<string>;
	/** Absolute path of the log file Studio writes (the `--outputFile`). */
	outputFile: string;
	/** Absolute path to the Studio executable. */
	studioPath: string;
	/** Milliseconds before the launch is abandoned and Studio is killed. */
	timeout: number;
}

/**
 * Spawns Studio and resolves once it exits (or rejects on timeout / spawn
 * failure). The injected seam: unit tests feed a fake that writes a canned
 * `--outputFile` log instead of launching Studio.
 */
export type StudioCliLauncher = (request: StudioCliLaunchRequest) => Promise<void>;

export interface StudioCliOptions {
	/** Place Builder seam; defaults to the real {@link defaultBuildPlace}. */
	buildPlace?: (options: BuildPlaceOptions) => BuildManifestArtifact;
	/** Studio-executable resolver seam; defaults to {@link discoverStudioPath}. */
	discover?: (override: string | undefined) => string;
	/** Process launcher seam; defaults to the real {@link spawnStudio}. */
	launch?: StudioCliLauncher;
	/** Explicit Studio executable path (override from config / CLI / env). */
	studioPath?: string;
	/** Run timeout in milliseconds. Defaults to 300000. */
	timeout?: number;
}

export class StudioCliBackend implements Backend {
	private readonly buildPlace: (options: BuildPlaceOptions) => BuildManifestArtifact;
	private readonly discover: (override: string | undefined) => string;
	private readonly launch: StudioCliLauncher;
	private readonly studioPath?: string;
	private readonly timeout: number;

	public readonly kind = "studio-cli" as const;

	constructor(options: StudioCliOptions = {}) {
		this.buildPlace = options.buildPlace ?? defaultBuildPlace;
		this.discover =
			options.discover ??
			((override) =>
				discoverStudioPath({ override: override ?? process.env[STUDIO_PATH_ENV] }));
		this.launch = options.launch ?? spawnStudio;
		this.studioPath = options.studioPath;
		this.timeout = options.timeout ?? DEFAULT_STUDIO_CLI_TIMEOUT;
	}

	public async runTests(options: BackendOptions): Promise<BackendResult> {
		const { jobs, parallel, workStealing } = options;
		if (jobs.length === 0) {
			throw new Error("StudioCliBackend requires at least one job");
		}

		if (workStealing === true) {
			throw new Error("studio-cli backend is serial and does not support work-stealing");
		}

		if (parallel !== undefined && parallel !== 1) {
			throw new Error(
				"studio-cli backend is serial (one Studio instance); --parallel > 1 is not supported.",
			);
		}

		// jobs[0] is the per-run knob source (rootDir, rojoProject, timeout).
		// eslint-disable-next-line ts/no-non-null-assertion -- length checked above
		const primary = jobs[0]!;
		const rootDirectory = path.resolve(primary.config.rootDir);
		const workDirectory = path.join(rootDirectory, WORK_DIR);
		fs.mkdirSync(workDirectory, { recursive: true });

		const placeFile = path.join(workDirectory, PLACE_FILE);
		this.buildPlace({
			loadStringEnabled: true,
			packages: [
				{
					name: BACKEND_NAME,
					packageDirectory: rootDirectory,
					rojoProjectPath: path.resolve(findRojoProject(primary.config)),
				},
			],
			placeFile,
			projectFile: path.join(workDirectory, PLACE_PROJECT_FILE),
			wrap: false,
		});

		const bootstrapFile = path.join(workDirectory, BOOTSTRAP_FILE);
		const outputFile = path.join(workDirectory, OUTPUT_FILE);
		fs.writeFileSync(bootstrapFile, buildBootstrap(jobs));

		const studioPath = this.discover(this.studioPath);
		const args = [
			"--task",
			"RunScript",
			"--localPlaceFile",
			normalizeWindowsPath(placeFile),
			"--runScriptFile",
			normalizeWindowsPath(bootstrapFile),
			"--outputFile",
			normalizeWindowsPath(outputFile),
			"--quitAfterExecution",
		];

		const executionStart = Date.now();
		await this.launch({ args, outputFile, studioPath, timeout: this.timeout });
		const executionMs = Date.now() - executionStart;

		const { gameOutput, jestOutput } = readStudioResult(outputFile);
		const entries = parseEnvelope(jestOutput);
		if (entries.length !== jobs.length) {
			throw new Error(
				`studio-cli backend returned ${entries.length.toString()} entries but request had ${jobs.length.toString()} jobs`,
			);
		}

		const rawResults: Array<RawBackendEntry> = entries.map((entry) => {
			return { entry, fallbackGameOutput: gameOutput };
		});

		return { rawResults, timing: { executionMs } };
	}
}

export function createStudioCliBackend(options: StudioCliOptions = {}): StudioCliBackend {
	return new StudioCliBackend(options);
}

/**
 * Wrap `content` in a Luau long string, escalating the bracket level
 * (`[=[`, `[==[`, …) until the chosen `]=*]` terminator does not occur in the
 * content. Without this, a config string carrying the level-1 terminator
 * `]=]` (e.g. a `testNamePattern`) would close the string early and emit
 * syntactically invalid Luau — a silent no-result run.
 */
function luauLongString(content: string): string {
	let level = 1;
	while (content.includes(`]${"=".repeat(level)}]`)) {
		level += 1;
	}

	const eq = "=".repeat(level);
	return `[${eq}[${content}]${eq}]`;
}

/**
 * The `--runScriptFile` payload. Runs at command-bar level in the edit
 * DataModel and drives the installed plugin's Run-mode runner via
 * `ExecuteRunModeAsync`, then prints the delimited result envelope so it lands
 * in `--outputFile`. A plugin that is absent or returns nothing produces a
 * `{ success = false }` envelope, so the host surfaces a clean error rather
 * than hanging.
 */
function buildBootstrap(jobs: Array<ProjectJob>): string {
	const configs: Array<JestArgv> = jobs.map((job) => buildJestArgv(job));
	const runtimeStubMounts = jobs.map((job) => job.runtimeInjectionPaths ?? []);
	const payload = JSON.stringify({
		config: { configs },
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		runtimeStubMounts,
		test: true,
	});

	return [
		'local HttpService = game:GetService("HttpService")',
		'local StudioTestService = game:GetService("StudioTestService")',
		`local payload = HttpService:JSONDecode(${luauLongString(payload)})`,
		`local DELIMITER = "${RESULT_DELIMITER}"`,
		"local function emit(value)",
		"\tprint(DELIMITER .. HttpService:JSONEncode(value) .. DELIMITER)",
		"end",
		"local ok, result = pcall(function()",
		"\treturn StudioTestService:ExecuteRunModeAsync(payload)",
		"end)",
		"if not ok then",
		'\temit({ gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = tostring(result), success = false }) })',
		'elseif typeof(result) ~= "table" or result.jestOutput == nil then',
		'\temit({ gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = "studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.", success = false }) })',
		"else",
		'\temit({ gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput })',
		"end",
		"",
	].join("\n");
}

function readStudioResult(outputFile: string): { gameOutput?: string; jestOutput: string } {
	let log: string;
	try {
		log = fs.readFileSync(outputFile, "utf8");
	} catch {
		throw new Error(NO_RESULT_ERROR);
	}

	const start = log.indexOf(RESULT_DELIMITER);
	if (start === -1) {
		throw new Error(NO_RESULT_ERROR);
	}

	const end = log.indexOf(RESULT_DELIMITER, start + RESULT_DELIMITER.length);
	if (end === -1) {
		throw new Error(NO_RESULT_ERROR);
	}

	const between = log.slice(start + RESULT_DELIMITER.length, end).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(between);
	} catch (err) {
		// A truncated/corrupt envelope (Studio crashed mid-write) throws a raw
		// SyntaxError here; rethrow as the backend's clean diagnostic so it
		// matches the schema-failure path below. The original error rides on
		// `cause` for debugging.
		throw new Error("studio-cli: malformed result envelope: invalid JSON", {
			cause: err,
		});
	}

	const wrapper = resultWrapperSchema(parsed);
	if (wrapper instanceof type.errors) {
		throw new Error(`studio-cli: malformed result envelope: ${wrapper.summary}`);
	}

	return { gameOutput: wrapper.gameOutput, jestOutput: wrapper.jestOutput };
}

/**
 * Real launcher: spawn Studio and resolve when it exits.
 * `--quitAfterExecution` makes Studio self-quit; the run timeout kills a hung
 * instance. A non-zero exit is not fatal on its own — the result is read from
 * `--outputFile` separately — but a spawn failure (no numeric exit code, e.g.
 * a bad `studioPath`) rejects so it isn't masked as an empty result.
 */
async function spawnStudio(request: StudioCliLaunchRequest): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		execFile(
			request.studioPath,
			request.args,
			{ timeout: request.timeout, windowsHide: true },
			(error) => {
				if (error === null) {
					resolve();
					return;
				}

				if (error.killed === true) {
					reject(
						new Error(
							`studio-cli: Studio run timed out after ${request.timeout.toString()}ms and was terminated.`,
						),
					);
					return;
				}

				if (typeof error.code === "number") {
					resolve();
					return;
				}

				reject(new Error(error.message, { cause: error }));
			},
		);
	});
}
