import * as path from "node:path";
import process from "node:process";
import { isAgent } from "std-env";

import { omitUndefined } from "../utils/omit-undefined.ts";
import type { CliOptions, FormatterEntry, WorkspaceRunOptions } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";
import type {
	ConsensusSpec,
	OptionalFieldSpec,
	PackageConfigEntry,
	RequiredFieldSpec,
} from "./workspace-consensus.ts";
import {
	assertConsensus,
	computeConsensus,
	resolveField,
	resolveOptionalField,
} from "./workspace-consensus.ts";

interface BuildWorkspaceRunOptionsInput {
	cli: CliOptions;
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>;
	/** Base directory for resolving the Aggregated Game Output path. */
	workspaceRoot?: string;
}

interface ResolvedOptionalFields {
	formatters: Array<FormatterEntry>;
	gameOutput: string | undefined;
	outputFile: string | undefined;
	parallel: "auto" | number | undefined;
	placeId: string | undefined;
	studioPath: string | undefined;
	universeId: string | undefined;
}

/**
 * Fields resolved as CLI override > per-package consensus > `DEFAULT_CONFIG`.
 */
const DEFAULTED_FIELD_SPECS = {
	backend: {
		name: "backend",
		default: DEFAULT_CONFIG.backend,
		readCli: (entry) => entry.backend,
		readConfig: (entry) => entry.backend,
	},
	color: {
		name: "color",
		default: DEFAULT_CONFIG.color,
		readCli: (entry) => entry.color,
		readConfig: (entry) => entry.color,
	},
	port: {
		name: "port",
		default: DEFAULT_CONFIG.port,
		readCli: (entry) => entry.port,
		readConfig: (entry) => entry.port,
	},
	silent: {
		name: "silent",
		default: DEFAULT_CONFIG.silent,
		readCli: (entry) => entry.silent,
		readConfig: (entry) => entry.test?.silent,
	},
} satisfies Record<string, RequiredFieldSpec<unknown>>;

/** Fields resolved as CLI override > per-package consensus > absent. */
const OPTIONAL_FIELD_SPECS = {
	gameOutput: {
		name: "gameOutput",
		readCli: (entry) => entry.gameOutput,
		readConfig: (entry) => entry.gameOutput,
	},
	outputFile: {
		name: "outputFile",
		readCli: (entry) => entry.outputFile,
		readConfig: (entry) => entry.outputFile,
	},
	parallel: {
		name: "parallel",
		readCli: (entry) => entry.parallel,
		readConfig: (entry) => entry.parallel,
	},
	placeId: {
		name: "placeId",
		readCli: (entry) => entry.placeId,
		readConfig: (entry) => entry.placeId,
	},
	// studio-cli's Studio-executable override. Resolved like placeId/universeId
	// so a config or CLI `studioPath` reaches the workspace studio-cli backend.
	studioPath: {
		name: "studioPath",
		readCli: (entry) => entry.studioPath,
		readConfig: (entry) => entry.studioPath,
	},
	universeId: {
		name: "universeId",
		readCli: (entry) => entry.universeId,
		readConfig: (entry) => entry.universeId,
	},
} satisfies Record<string, OptionalFieldSpec<unknown>>;

/**
 * Fields resolved by per-package consensus alone — there is no CLI flag to
 * override them, so a disagreement can only be settled in the configs.
 */
const CONSENSUS_ONLY_SPECS = {
	workspaceGameOutput: {
		name: "workspace.gameOutput",
		readConfig: (entry) => entry.workspace?.gameOutput,
	},
	workspaceOutputFile: {
		name: "workspace.outputFile",
		readConfig: (entry) => entry.workspace?.outputFile,
	},
} satisfies Record<string, ConsensusSpec<unknown>>;

// Convergence guard. `workspace.packages`/`root` live in a shared config
// reached via `extends:`, so every selected package resolves the same value. A
// package that overrides it — or forgets to extend the shared config — surfaces
// here as a conflict rather than silently running against a different package
// set. The values themselves were already consumed for enumeration, so only the
// disagreement is read out.
const CONVERGENCE_GUARD_SPECS = [
	{
		name: "workspace.packages",
		readConfig: (entry) => entry.workspace?.packages,
	},
	{
		name: "workspace.root",
		readConfig: (entry) => entry.workspace?.root,
	},
] satisfies Array<ConsensusSpec<unknown>>;

export function buildWorkspaceRunOptions({
	cli,
	perPackageConfigs,
	workspaceRoot = process.cwd(),
}: BuildWorkspaceRunOptionsInput): WorkspaceRunOptions {
	return {
		...resolveDefaultedFields(cli, perPackageConfigs),
		...resolveConsensusOnlyFields(perPackageConfigs),
		...omitUndefined(resolveOptionalFields(cli, perPackageConfigs, workspaceRoot)),
	};
}

function resolveDefaultedFields(
	cli: CliOptions,
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
): Pick<WorkspaceRunOptions, "backend" | "bail" | "color" | "port" | "silent"> {
	return {
		backend: resolveField(cli, perPackageConfigs, DEFAULTED_FIELD_SPECS.backend),
		// Straight off the CLI rather than through the consensus table: there
		// is no config key to reach consensus on. `test.bail` is already Jest's
		// suite-level bail, so reading it here would give one word two jobs.
		bail: cli.bail === true,
		color: resolveField(cli, perPackageConfigs, DEFAULTED_FIELD_SPECS.color),
		port: resolveField(cli, perPackageConfigs, DEFAULTED_FIELD_SPECS.port),
		silent: resolveField(cli, perPackageConfigs, DEFAULTED_FIELD_SPECS.silent),
	};
}

function resolveConsensusOnlyFields(
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
): Pick<WorkspaceRunOptions, "workspaceGameOutput" | "workspaceOutputFile"> {
	const isWorkspaceGameOutputEnabled =
		computeConsensus(perPackageConfigs, CONSENSUS_ONLY_SPECS.workspaceGameOutput) === true;
	const isWorkspaceOutputFileEnabled =
		computeConsensus(perPackageConfigs, CONSENSUS_ONLY_SPECS.workspaceOutputFile) === true;

	for (const spec of CONVERGENCE_GUARD_SPECS) {
		assertConsensus(perPackageConfigs, spec);
	}

	return {
		workspaceGameOutput: isWorkspaceGameOutputEnabled,
		workspaceOutputFile: isWorkspaceOutputFileEnabled,
	};
}

function defaultFormatters(): Array<FormatterEntry> {
	const defaults: Array<FormatterEntry> = isAgent ? ["agent"] : ["default"];

	if (process.env["GITHUB_ACTIONS"] === "true") {
		defaults.push("github-actions");
	}

	return defaults;
}

function resolveFormatters(
	cli: CliOptions,
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
): Array<FormatterEntry> {
	const cliValue = cli.formatters;
	if (cliValue !== undefined) {
		return cliValue;
	}

	const consensus = computeConsensus(perPackageConfigs, {
		name: "formatters",
		readConfig: (entry) => entry.formatters,
	});

	if (consensus !== undefined) {
		return consensus;
	}

	return defaultFormatters();
}

// `true` expands to `defaultName`; relative paths (including that default)
// anchor at the workspace root so the aggregate lands there regardless of the
// directory the CLI was invoked from.
function resolveAggregateArtifactPath(
	value: string | true | undefined,
	workspaceRoot: string,
	defaultName: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const target = value === true ? defaultName : value;
	return path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
}

// `formatters` rides along here rather than with the defaulted fields: it has
// no `DEFAULT_CONFIG` entry either, but falls back to an env-probed list rather
// than to nothing. The two aggregate sinks resolve to a path on the way out;
// the rest pass through untouched.
function resolveOptionalFields(
	cli: CliOptions,
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
	workspaceRoot: string,
): ResolvedOptionalFields {
	return {
		formatters: resolveFormatters(cli, perPackageConfigs),
		gameOutput: resolveAggregateArtifactPath(
			resolveOptionalField(cli, perPackageConfigs, OPTIONAL_FIELD_SPECS.gameOutput),
			workspaceRoot,
			"game-output.log",
		),
		outputFile: resolveAggregateArtifactPath(
			resolveOptionalField(cli, perPackageConfigs, OPTIONAL_FIELD_SPECS.outputFile),
			workspaceRoot,
			"jest-output.log",
		),
		parallel: resolveOptionalField(cli, perPackageConfigs, OPTIONAL_FIELD_SPECS.parallel),
		placeId: resolveOptionalField(cli, perPackageConfigs, OPTIONAL_FIELD_SPECS.placeId),
		studioPath: resolveOptionalField(cli, perPackageConfigs, OPTIONAL_FIELD_SPECS.studioPath),
		universeId: resolveOptionalField(cli, perPackageConfigs, OPTIONAL_FIELD_SPECS.universeId),
	};
}

export { WorkspaceConsensusError } from "./workspace-consensus.ts";
