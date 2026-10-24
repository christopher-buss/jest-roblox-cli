import * as path from "node:path";
import process from "node:process";
import { isDefined, pickBy } from "remeda";

import { defaultFormatters } from "./default-formatters.ts";
import type { CliOptions, FormatterEntry, WorkspaceRunOptions } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";
import type {
	ConsensusSpec,
	FieldSources,
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
	platform?: NodeJS.Platform;
	/** Base directory for resolving the Aggregated Game Output path. */
	workspaceRoot?: string;
}

interface ResolvedOptionalFields {
	formatters: Array<FormatterEntry>;
	gameOutput: string | undefined;
	hiddenDesktop: boolean | undefined;
	outputFile: string | undefined;
	parallel: "auto" | number | undefined;
	placeId: string | undefined;
	pluginsDirectory: string | undefined;
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
	pluginsDirectory: {
		name: "pluginsDirectory",
		readConfig: (entry) => entry.pluginsDirectory,
	},
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
	platform = process.platform,
	workspaceRoot = process.cwd(),
}: BuildWorkspaceRunOptionsInput): WorkspaceRunOptions {
	return {
		...resolveDefaultedFields({ cli, perPackageConfigs }),
		...resolveConsensusOnlyFields(perPackageConfigs),
		...pickBy(
			resolveOptionalFields({ cli, perPackageConfigs, platform, workspaceRoot }),
			isDefined,
		),
	};
}

function resolveDefaultedFields(
	sources: FieldSources,
): Pick<
	WorkspaceRunOptions,
	"backend" | "bail" | "color" | "experimentalVmParallel" | "port" | "silent"
> {
	return {
		backend: resolveField({ ...sources, spec: DEFAULTED_FIELD_SPECS.backend }),
		// Straight off the CLI rather than through the consensus table: there
		// is no config key to reach consensus on. `test.bail` is already Jest's
		// suite-level bail, so reading it here would give one word two jobs.
		bail: sources.cli.bail === true,
		color: resolveField({ ...sources, spec: DEFAULTED_FIELD_SPECS.color }),
		experimentalVmParallel: sources.cli.experimentalVmParallel,
		port: resolveField({ ...sources, spec: DEFAULTED_FIELD_SPECS.port }),
		silent: resolveField({ ...sources, spec: DEFAULTED_FIELD_SPECS.silent }),
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

function hiddenDesktopSpec({
	perPackageConfigs,
	platform,
}: {
	readonly perPackageConfigs: ReadonlyArray<PackageConfigEntry>;
	readonly platform: NodeJS.Platform;
}): OptionalFieldSpec<boolean> {
	const isAnySet = perPackageConfigs.some(({ config }) => config.hiddenDesktop !== undefined);
	const isHiddenByDefault = platform === "win32" || platform === "darwin";
	return {
		name: "hiddenDesktop",
		readCli: (entry) => entry.hiddenDesktop,
		readConfig: (entry) => (isAnySet ? (entry.hiddenDesktop ?? isHiddenByDefault) : undefined),
	};
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
function resolveAggregateArtifactPath({
	defaultName,
	value,
	workspaceRoot,
}: {
	readonly defaultName: string;
	readonly value: string | true | undefined;
	readonly workspaceRoot: string;
}): string | undefined {
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
function resolveOptionalFields({
	platform,
	workspaceRoot,
	...sources
}: FieldSources & {
	readonly platform: NodeJS.Platform;
	readonly workspaceRoot: string;
}): ResolvedOptionalFields {
	const { cli, perPackageConfigs } = sources;
	return {
		formatters: resolveFormatters(cli, perPackageConfigs),
		gameOutput: resolveAggregateArtifactPath({
			defaultName: "game-output.log",
			value: resolveOptionalField({ ...sources, spec: OPTIONAL_FIELD_SPECS.gameOutput }),
			workspaceRoot,
		}),
		hiddenDesktop: resolveOptionalField({
			...sources,
			spec: hiddenDesktopSpec({ perPackageConfigs, platform }),
		}),
		outputFile: resolveAggregateArtifactPath({
			defaultName: "jest-output.log",
			value: resolveOptionalField({ ...sources, spec: OPTIONAL_FIELD_SPECS.outputFile }),
			workspaceRoot,
		}),
		parallel: resolveOptionalField({ ...sources, spec: OPTIONAL_FIELD_SPECS.parallel }),
		placeId: resolveOptionalField({ ...sources, spec: OPTIONAL_FIELD_SPECS.placeId }),
		pluginsDirectory: computeConsensus(
			perPackageConfigs,
			CONSENSUS_ONLY_SPECS.pluginsDirectory,
		),
		studioPath: resolveOptionalField({ ...sources, spec: OPTIONAL_FIELD_SPECS.studioPath }),
		universeId: resolveOptionalField({ ...sources, spec: OPTIONAL_FIELD_SPECS.universeId }),
	};
}

export { WorkspaceConsensusError } from "./workspace-consensus.ts";
