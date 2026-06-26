import * as path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { isAgent } from "std-env";

import type { CliOptions, Config, FormatterEntry, WorkspaceRunOptions } from "./schema.ts";
import { DEFAULT_CONFIG } from "./schema.ts";

interface ConsensusGroup<T> {
	packages: Array<string>;
	value: T;
}

interface PackageConfigEntry {
	name: string;
	config: Config;
}

interface BuildWorkspaceRunOptionsInput {
	cli: CliOptions;
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>;
	/** Base directory for resolving the Aggregated Game Output path. */
	workspaceRoot?: string;
}

interface ConsensusSpec<T> {
	name: string;
	readConfig: (config: Config) => T | undefined;
}

interface RequiredFieldSpec<T> extends ConsensusSpec<T> {
	default: T;
	readCli: (cli: CliOptions) => T | undefined;
}

interface OptionalFieldSpec<T> extends ConsensusSpec<T> {
	readCli: (cli: CliOptions) => T | undefined;
}

export class WorkspaceConsensusError extends Error {
	public readonly field: string;
	public readonly groups: ReadonlyArray<ConsensusGroup<unknown>>;
	public override readonly name = "WorkspaceConsensusError";
	public readonly omittedBy: ReadonlyArray<string>;

	constructor(
		field: string,
		groups: ReadonlyArray<ConsensusGroup<unknown>>,
		omittedBy: ReadonlyArray<string> = [],
	) {
		super(formatMessage(field, groups, omittedBy));
		this.field = field;
		this.groups = groups;
		this.omittedBy = omittedBy;
	}
}

export function buildWorkspaceRunOptions(
	input: BuildWorkspaceRunOptionsInput,
): WorkspaceRunOptions {
	const { cli, perPackageConfigs, workspaceRoot = process.cwd() } = input;

	const backend = resolveField(cli, perPackageConfigs, {
		name: "backend",
		default: DEFAULT_CONFIG.backend,
		readCli: (entry) => entry.backend,
		readConfig: (entry) => entry.backend,
	});

	const color = resolveField(cli, perPackageConfigs, {
		name: "color",
		default: DEFAULT_CONFIG.color,
		readCli: (entry) => entry.color,
		readConfig: (entry) => entry.color,
	});

	const port = resolveField(cli, perPackageConfigs, {
		name: "port",
		default: DEFAULT_CONFIG.port,
		readCli: (entry) => entry.port,
		readConfig: (entry) => entry.port,
	});

	const silent = resolveField(cli, perPackageConfigs, {
		name: "silent",
		default: DEFAULT_CONFIG.silent,
		readCli: (entry) => entry.silent,
		readConfig: (entry) => entry.test?.silent,
	});

	const parallel = resolveOptionalField(cli, perPackageConfigs, {
		name: "parallel",
		readCli: (entry) => entry.parallel,
		readConfig: (entry) => entry.parallel,
	});

	const placeId = resolveOptionalField(cli, perPackageConfigs, {
		name: "placeId",
		readCli: (entry) => entry.placeId,
		readConfig: (entry) => entry.placeId,
	});

	const universeId = resolveOptionalField(cli, perPackageConfigs, {
		name: "universeId",
		readCli: (entry) => entry.universeId,
		readConfig: (entry) => entry.universeId,
	});

	// studio-cli's Studio-executable override. Resolved like placeId/universeId
	// so a config or CLI `studioPath` reaches the workspace studio-cli backend.
	const studioPath = resolveOptionalField(cli, perPackageConfigs, {
		name: "studioPath",
		readCli: (entry) => entry.studioPath,
		readConfig: (entry) => entry.studioPath,
	});

	const formatters = resolveFormatters(cli, perPackageConfigs);

	const rawGameOutput = resolveOptionalField(cli, perPackageConfigs, {
		name: "gameOutput",
		readCli: (entry) => entry.gameOutput,
		readConfig: (entry) => entry.gameOutput,
	});

	const rawOutputFile = resolveOptionalField(cli, perPackageConfigs, {
		name: "outputFile",
		readCli: (entry) => entry.outputFile,
		readConfig: (entry) => entry.outputFile,
	});

	const workspaceGameOutput =
		computeConsensus(perPackageConfigs, {
			name: "workspace.gameOutput",
			readConfig: (entry) => entry.workspace?.gameOutput,
		}) === true;

	const workspaceOutputFile =
		computeConsensus(perPackageConfigs, {
			name: "workspace.outputFile",
			readConfig: (entry) => entry.workspace?.outputFile,
		}) === true;

	// Convergence guard. `workspace.packages`/`root` live in a shared config
	// reached via `extends:`, so every selected package resolves the same
	// value. A package that overrides it — or forgets to extend the shared
	// config — surfaces here as a conflict rather than silently running against
	// a different package set. Throws on disagreement; the values themselves
	// were already consumed for enumeration.
	computeConsensus(perPackageConfigs, {
		name: "workspace.packages",
		readConfig: (entry) => entry.workspace?.packages,
	});
	computeConsensus(perPackageConfigs, {
		name: "workspace.root",
		readConfig: (entry) => entry.workspace?.root,
	});

	const runOptions: WorkspaceRunOptions = {
		backend,
		color,
		formatters,
		port,
		silent,
		workspaceGameOutput,
		workspaceOutputFile,
	};

	const gameOutput = resolveAggregateArtifactPath(
		rawGameOutput,
		workspaceRoot,
		"game-output.log",
	);
	if (gameOutput !== undefined) {
		runOptions.gameOutput = gameOutput;
	}

	const outputFile = resolveAggregateArtifactPath(
		rawOutputFile,
		workspaceRoot,
		"jest-output.log",
	);
	if (outputFile !== undefined) {
		runOptions.outputFile = outputFile;
	}

	if (parallel !== undefined) {
		runOptions.parallel = parallel;
	}

	if (placeId !== undefined) {
		runOptions.placeId = placeId;
	}

	if (studioPath !== undefined) {
		runOptions.studioPath = studioPath;
	}

	if (universeId !== undefined) {
		runOptions.universeId = universeId;
	}

	return runOptions;
}

function formatMessage(
	field: string,
	groups: ReadonlyArray<ConsensusGroup<unknown>>,
	omittedBy: ReadonlyArray<string>,
): string {
	const lines = [`workspace packages disagree on \`${field}\`.`, ""];

	for (const group of groups) {
		const valueText = JSON.stringify(group.value);
		if (omittedBy.length > 0) {
			lines.push(`  - declared as ${valueText} by: ${group.packages.join(", ")}`);
		} else {
			lines.push(`  - ${valueText} — declared by ${group.packages.join(", ")}`);
		}
	}

	if (omittedBy.length > 0) {
		lines.push(`  - not declared by: ${omittedBy.join(", ")}`);
	}

	lines.push(
		"",
		"In workspace mode this field must be uniform across all selected",
		`packages — the entire run uses one ${field}. Either:`,
		"  - Declare it consistently across packages (typically by inheriting",
		"    from a shared config), OR",
		"  - Pass the CLI override to set a single value for the run.",
	);

	return lines.join("\n");
}

function computeConsensus<T>(
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
	spec: ConsensusSpec<T>,
): T | undefined {
	const groups: Array<ConsensusGroup<T>> = [];
	const omittedBy: Array<string> = [];

	for (const entry of perPackageConfigs) {
		const value = spec.readConfig(entry.config);
		if (value === undefined) {
			omittedBy.push(entry.name);
			continue;
		}

		const existing = groups.find((group) => isDeepStrictEqual(group.value, value));
		if (existing === undefined) {
			groups.push({ packages: [entry.name], value });
		} else {
			existing.packages.push(entry.name);
		}
	}

	const [first] = groups;
	if (first === undefined) {
		return undefined;
	}

	if (groups.length === 1 && omittedBy.length === 0) {
		return first.value;
	}

	throw new WorkspaceConsensusError(spec.name, groups, omittedBy);
}

function resolveField<T>(
	cli: CliOptions,
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
	spec: RequiredFieldSpec<T>,
): T {
	const cliValue = spec.readCli(cli);
	if (cliValue !== undefined) {
		return cliValue;
	}

	const consensus = computeConsensus(perPackageConfigs, spec);
	return consensus ?? spec.default;
}

function resolveOptionalField<T>(
	cli: CliOptions,
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
	spec: OptionalFieldSpec<T>,
): T | undefined {
	const cliValue = spec.readCli(cli);
	if (cliValue !== undefined) {
		return cliValue;
	}

	return computeConsensus(perPackageConfigs, spec);
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

export type { ConsensusGroup };
