import { isDeepStrictEqual } from "node:util";

import type { CliOptions, Config } from "./schema.ts";

interface ConsensusGroup<T> {
	packages: Array<string>;
	value: T;
}

interface PackageConfigEntry {
	name: string;
	config: Config;
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

export function computeConsensus<T>(
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

// Consensus as a guard rather than a source: the field was already consumed
// elsewhere, so only the disagreement is interesting here.
export function assertConsensus(
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
	spec: ConsensusSpec<unknown>,
): void {
	computeConsensus(perPackageConfigs, spec);
}

export function resolveField<T>(
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

export function resolveOptionalField<T>(
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

export type {
	ConsensusGroup,
	ConsensusSpec,
	OptionalFieldSpec,
	PackageConfigEntry,
	RequiredFieldSpec,
};
