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
	const { cli, perPackageConfigs } = input;

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

	const pollInterval = resolveField(cli, perPackageConfigs, {
		name: "pollInterval",
		default: DEFAULT_CONFIG.pollInterval,
		readCli: (entry) => entry.pollInterval,
		readConfig: (entry) => entry.pollInterval,
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

	const formatters = resolveFormatters(cli, perPackageConfigs);

	const runOptions: WorkspaceRunOptions = {
		backend,
		color,
		formatters,
		pollInterval,
		port,
		silent,
	};

	if (parallel !== undefined) {
		runOptions.parallel = parallel;
	}

	if (placeId !== undefined) {
		runOptions.placeId = placeId;
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

export type { ConsensusGroup };
