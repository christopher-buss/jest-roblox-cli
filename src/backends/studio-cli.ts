import { type } from "arktype";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { resolvePlaceFilePath } from "../config/schema.ts";
import type { BuildManifestArtifact } from "../coverage-pipeline/build-manifest.ts";
import { findRojoProject } from "../coverage-pipeline/prepare.ts";
import {
	type BuildPlaceOptions,
	buildPlace as defaultBuildPlace,
} from "../staging/place-builder.ts";
import { normalizeWindowsPath } from "../utils/normalize-windows-path.ts";
import { parseEnvelope } from "./envelope.ts";
import {
	type Backend,
	type BackendOptions,
	type BackendResult,
	isWorkspaceRun,
	type ProjectJob,
	type RawBackendEntry,
} from "./interface.ts";
import { buildConfigEntries, buildWorkspaceEntries } from "./plugin-payload.ts";
import { discoverStudioPath } from "./studio-discovery.ts";

const DEFAULT_STUDIO_CLI_TIMEOUT = 300_000;

/** Lowest-precedence Studio-executable override (below config key / CLI flag). */
const STUDIO_PATH_ENV = "JEST_ROBLOX_STUDIO_PATH";

/**
 * Plugin/CLI protocol version, carried in the Run-mode payload. Matches
 * `STUDIO_PROTOCOL_VERSION` in the WebSocket `studio` backend and
 * `PROTOCOL_VERSION` in the plugin. The bootstrap echoes the version the
 * run-mode runner returns; {@link assertProtocolMatch} rejects a plugin that
 * omits the echo (a stale runner predating the handshake) or returns a
 * different number, surfacing a clean "update the plugin" error.
 */
const STUDIO_CLI_PROTOCOL_VERSION = 3;

/**
 * Stable marker the bootstrap brackets the result envelope with so the host can
 * recover it from a `--outputFile` log interleaved with engine/plugin lines.
 * Emitted on its own line (before and after the JSON chunks) — see
 * {@link RESULT_CHUNK_SIZE}.
 */
const RESULT_DELIMITER = "@@JEST_ROBLOX_STUDIO_CLI_RESULT@@";

/**
 * Max characters per `print` in the chunked result envelope. Studio truncates a
 * single console message at ~100k chars (observed: a 100,010-char envelope lost
 * its tail and its closing delimiter, producing "invalid JSON"). So the
 * bootstrap slices the JSON-encoded envelope into sub-cap chunks, each on its
 * own `print` line bracketed by {@link RESULT_DELIMITER} marker lines, and the
 * host rejoins the lines between the markers. 8000 keeps a wide margin under the
 * cap while bounding the emitted line count even for very large suites.
 */
const RESULT_CHUNK_SIZE = 8000;

const BACKEND_NAME = "studio-cli";
const WORK_DIR = path.join(".jest-roblox", BACKEND_NAME);
const PLACE_FILE = "place.rbxl";
const PLACE_PROJECT_FILE = "place.project.json";
const BOOTSTRAP_FILE = "bootstrap.server.luau";
const OUTPUT_FILE = "output.log";

const NO_RESULT_ERROR =
	"studio-cli: no test result was produced. Ensure Roblox Studio launched and " +
	"the jest-roblox Studio plugin is installed.";

const resultWrapperSchema = type({
	"gameOutput?": "string",
	"jestOutput": "string",
	"protocolVersion?": "number",
});

export interface StudioCliLaunchRequest {
	/** Full Studio CLI argument vector (already absolute paths). */
	args: Array<string>;
	/**
	 * Show the Studio window during the run (`--headed`) instead of the default
	 * hidden window. Maps to `windowsHide: !headed` in {@link spawnStudio}.
	 */
	headed: boolean;
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
	/**
	 * Show the Studio window during the run (`--headed`). CLI-only — never read
	 * from config. Defaults to false (hidden window).
	 */
	headed?: boolean;
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
	private readonly headed: boolean;
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
		this.headed = options.headed ?? false;
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

		// Which place studio-cli drives, by run shape:
		// - workspace: the synthesized mega-place the workspace runner already
		//   built (with the `__pkg_stage` staging the materializer clones from);
		// - coverage: the Coverage-Instrumented Place `prepareCoverage` built and
		//   recorded in `config.placeFile` — a Clean Place here drops the
		//   instrumentation and reports 0% for every file;
		// - normal: a freshly built Clean Place.
		// Only the normal path builds here; the others reuse `config.placeFile`,
		// already built with LoadStringEnabled so the Run-mode gate passes.
		const workspace = isWorkspaceRun(jobs);
		let placeFile: string;
		if (workspace) {
			placeFile = path.resolve(primary.config.placeFile);
		} else if (primary.config.collectCoverage) {
			placeFile = resolvePlaceFilePath(primary.config);
		} else {
			placeFile = this.buildCleanPlace(primary, rootDirectory, workDirectory);
		}

		const bootstrapFile = path.join(workDirectory, BOOTSTRAP_FILE);
		const outputFile = path.join(workDirectory, OUTPUT_FILE);
		fs.writeFileSync(
			bootstrapFile,
			buildBootstrap(workspace ? buildWorkspacePayload(jobs) : buildConfigsPayload(jobs)),
		);

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
		await this.launch({
			args,
			headed: this.headed,
			outputFile,
			studioPath,
			timeout: this.timeout,
		});
		const executionMs = Date.now() - executionStart;

		const { gameOutput, jestOutput, protocolVersion } = readStudioResult(outputFile);
		// parseEnvelope before the version check: when the bootstrap reached the
		// plugin but got nothing back (ExecuteRunModeAsync threw, or returned no
		// result) it emits a `{success:false, err}` envelope with no
		// protocolVersion, and that error must win over assertProtocolMatch so
		// the real cause surfaces instead of a misleading version mismatch. (A
		// plugin that produced no delimited result at all is already caught
		// upstream by readStudioResult's NO_RESULT_ERROR.)
		const entries = parseEnvelope(jestOutput);
		assertProtocolMatch(protocolVersion);
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

	/**
	 * Build the Clean Place for a normal (non-coverage) run and return its path.
	 * `loadStringEnabled` is forced on so the Run-mode runner's LoadString gate
	 * passes. Coverage runs skip this and open the instrumented place instead.
	 */
	private buildCleanPlace(
		primary: ProjectJob,
		rootDirectory: string,
		workDirectory: string,
	): string {
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

		return placeFile;
	}
}

export function createStudioCliBackend(options: StudioCliOptions = {}): StudioCliBackend {
	return new StudioCliBackend(options);
}

/**
 * Single-/multi-project payload: the run-mode runner reads `config.configs` and
 * drives `Runner.runProjects`.
 */
function buildConfigsPayload(jobs: Array<ProjectJob>): object {
	const { configs, runtimeStubMounts } = buildConfigEntries(jobs);
	return {
		config: { configs },
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		runtimeStubMounts,
		test: true,
	};
}

/**
 * Workspace payload: the run-mode runner sees the `workspace` shape and drives
 * the staged materializer (`runEmbedded`) — cloning each package from the
 * mega-place's `__pkg_stage`, running, resetting.
 */
function buildWorkspacePayload(jobs: Array<ProjectJob>): object {
	return {
		protocolVersion: STUDIO_CLI_PROTOCOL_VERSION,
		test: true,
		workspace: { entries: buildWorkspaceEntries(jobs) },
	};
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
 * The `--runScriptFile` script. Runs at command-bar level in the edit DataModel
 * and drives the installed plugin's Run-mode runner via `ExecuteRunModeAsync`
 * with the given `payload`, then prints the delimited result envelope so it
 * lands in `--outputFile`. A plugin that is absent or returns nothing produces a
 * `{ success = false }` envelope, so the host surfaces a clean error rather than
 * hanging.
 */
function buildBootstrap(payload: object): string {
	return [
		'local HttpService = game:GetService("HttpService")',
		'local StudioTestService = game:GetService("StudioTestService")',
		`local payload = HttpService:JSONDecode(${luauLongString(String(JSON.stringify(payload)))})`,
		`local DELIMITER = "${RESULT_DELIMITER}"`,
		// Emit as `DELIMITER` / chunk* / `DELIMITER`, one chunk per `print`. A
		// single `print` of the whole envelope is truncated at Studio's
		// ~100k-char message cap (losing the closing delimiter → "invalid JSON"),
		// so the JSON is sliced into sub-cap pieces and the host rejoins the
		// lines between the markers. See RESULT_CHUNK_SIZE.
		"local function emit(value)",
		"\tlocal encoded = HttpService:JSONEncode(value)",
		"\tprint(DELIMITER)",
		"\tlocal total = #encoded",
		"\tlocal index = 1",
		"\twhile index <= total do",
		`\t\tprint(string.sub(encoded, index, index + ${(RESULT_CHUNK_SIZE - 1).toString()}))`,
		`\t\tindex = index + ${RESULT_CHUNK_SIZE.toString()}`,
		"\tend",
		"\tprint(DELIMITER)",
		"end",
		"local ok, result = pcall(function()",
		"\treturn StudioTestService:ExecuteRunModeAsync(payload)",
		"end)",
		"if not ok then",
		'\temit({ gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = tostring(result), success = false }) })',
		'elseif typeof(result) ~= "table" or result.jestOutput == nil then',
		'\temit({ gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = "studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.", success = false }) })',
		"else",
		'\temit({ gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput, protocolVersion = result.protocolVersion })',
		"end",
		"",
	].join("\n");
}

/**
 * Reject a run-mode result whose echoed `protocolVersion` doesn't match the
 * CLI's. A stale plugin (run-mode runner predating the handshake) omits the
 * echo entirely (`undefined`); a divergent plugin echoes a different number.
 * Either way the user must update the plugin. Mirrors the WebSocket backend's
 * `version_mismatch` path.
 */
function assertProtocolMatch(actual: number | undefined): void {
	if (actual === STUDIO_CLI_PROTOCOL_VERSION) {
		return;
	}

	const reported = actual === undefined ? "no version" : `v${actual.toString()}`;
	throw new Error(
		"studio-cli: jest-roblox Studio plugin protocol version mismatch " +
			`(plugin reported ${reported}, CLI expects v${STUDIO_CLI_PROTOCOL_VERSION.toString()}). ` +
			"Update the jest-roblox Studio plugin to match this CLI version.",
	);
}

function readStudioResult(outputFile: string): {
	gameOutput?: string;
	jestOutput: string;
	protocolVersion?: number;
} {
	let log: string;
	try {
		log = fs.readFileSync(outputFile, "utf8");
	} catch {
		throw new Error(NO_RESULT_ERROR);
	}

	// The bootstrap brackets the envelope with `RESULT_DELIMITER` on its OWN
	// line, before and after the JSON chunks (chunked to dodge Studio's ~100k
	// per-message truncation — see RESULT_CHUNK_SIZE). Recover it by the last two
	// whole-line markers and rejoin everything between them:
	//   - whole-line match (trimmed === delimiter) ignores the echoed bootstrap
	//     script's `local DELIMITER = "…"` / `print(DELIMITER)` lines, which
	//     contain the delimiter but are never equal to it;
	//   - the LAST two markers are the real emit's pair, after any echo/engine
	//     lines;
	//   - joining the lines between them concatenates the chunks back into the
	//     original JSON (JSONEncode output carries no literal newlines).
	const lines = log.split(/\r?\n/);
	const markerLines: Array<number> = [];
	for (const [lineIndex, line] of lines.entries()) {
		if (line.trim() === RESULT_DELIMITER) {
			markerLines.push(lineIndex);
		}
	}

	const endMarker = markerLines.at(-1);
	const startMarker = markerLines.at(-2);
	if (startMarker === undefined || endMarker === undefined) {
		throw new Error(NO_RESULT_ERROR);
	}

	const between = lines
		.slice(startMarker + 1, endMarker)
		.join("")
		.trim();
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

	return {
		gameOutput: wrapper.gameOutput,
		jestOutput: wrapper.jestOutput,
		protocolVersion: wrapper.protocolVersion,
	};
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
		// headed mode intentionally shows the Studio window; `!request.headed` is
		// the deliberate lever, not an accidental terminal popup.
		execFile(
			request.studioPath,
			request.args,
			{ timeout: request.timeout, windowsHide: !request.headed },
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
