import { isDeepStrictEqual } from "node:util";

import type { Config } from "./config-types.ts";
import type { CliOptions } from "./resolved-config.ts";

/** Where a workspace-wide field value can come from. */
export interface FieldSources {
	/** CLI flags; they override every package. */
	readonly cli: CliOptions;
	/** Raw config of each selected package. */
	readonly perPackageConfigs: ReadonlyArray<PackageConfigEntry>;
}

interface PackageConfigEntry {
	name: string;
	config: Config;
}

interface ConsensusGroup<T> {
	packages: Array<string>;
	value: T;
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

/** Thrown when selected packages disagree on a field that must be uniform. */
class WorkspaceConsensusError extends Error {
	public readonly field: string;
	public readonly groups: ReadonlyArray<ConsensusGroup<unknown>>;
	public override readonly name = "WorkspaceConsensusError";
	public readonly omittedBy: ReadonlyArray<string>;

	/**
	 * Record the disagreement and format its message.
	 *
	 * @param field - Name of the disputed field.
	 * @param groups - Packages grouped by the value they declare.
	 * @param omittedBy - Packages that do not declare the field.
	 */
	constructor(
		field: string,
		groups: ReadonlyArray<ConsensusGroup<unknown>>,
		omittedBy: ReadonlyArray<string>,
	) {
		super(formatMessage({ field, groups, omittedBy }));
		this.field = field;
		this.groups = groups;
		this.omittedBy = omittedBy;
	}
}

/**
 * Read a field from every package and require one shared value.
 *
 * @template T - Field value type.
 * @param perPackageConfigs - Raw config of each selected package.
 * @param spec - Field name and how to read it from a config.
 * @returns The shared value, or `undefined` when no package declares it.
 * @throws {WorkspaceConsensusError} If packages declare different values, or
 *   some declare it and others do not.
 */
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

/**
 * Require packages to agree on a field without reading its value.
 *
 * @param perPackageConfigs - Raw config of each selected package.
 * @param spec - Field name and how to read it from a config.
 * @throws {WorkspaceConsensusError} If the packages do not agree.
 */
export function assertConsensus(
	perPackageConfigs: ReadonlyArray<PackageConfigEntry>,
	spec: ConsensusSpec<unknown>,
): void {
	computeConsensus(perPackageConfigs, spec);
}

/**
 * Resolve a field from the CLI, else package consensus, else its default.
 *
 * @template T - Field value type.
 * @param options - Field sources and the field spec.
 * @returns The resolved value.
 * @throws {WorkspaceConsensusError} If no CLI value is given and the packages
 *   do not agree.
 */
export function resolveField<T>({
	cli,
	perPackageConfigs,
	spec,
}: FieldSources & {
	/** Field name, readers and default. */
	readonly spec: RequiredFieldSpec<T>;
}): T {
	const cliValue = spec.readCli(cli);
	if (cliValue !== undefined) {
		return cliValue;
	}

	const consensus = computeConsensus(perPackageConfigs, spec);
	return consensus ?? spec.default;
}

/**
 * Resolve a field from the CLI, else package consensus.
 *
 * @template T - Field value type.
 * @param options - Field sources and the field spec.
 * @returns The resolved value, or `undefined` when no source sets it.
 * @throws {WorkspaceConsensusError} If no CLI value is given and the packages
 *   do not agree.
 */
export function resolveOptionalField<T>({
	cli,
	perPackageConfigs,
	spec,
}: FieldSources & {
	/** Field name and readers. */
	readonly spec: OptionalFieldSpec<T>;
}): T | undefined {
	const cliValue = spec.readCli(cli);
	if (cliValue !== undefined) {
		return cliValue;
	}

	return computeConsensus(perPackageConfigs, spec);
}

function formatMessage({
	field,
	groups,
	omittedBy,
}: {
	readonly field: string;
	readonly groups: ReadonlyArray<ConsensusGroup<unknown>>;
	readonly omittedBy: ReadonlyArray<string>;
}): string {
	const lines = [`workspace packages disagree on \`${field}\`.`, ""];

	for (const group of groups) {
		const valueText = JSON.stringify(group.value);
		if (omittedBy.length > 0) {
			lines.push(`  - declared as ${valueText} by: ${group.packages.join(", ")}`);
		} else {
			lines.push(`  - ${valueText} (declared by ${group.packages.join(", ")})`);
		}
	}

	if (omittedBy.length > 0) {
		lines.push(`  - not declared by: ${omittedBy.join(", ")}`);
	}

	lines.push(
		"",
		"In workspace mode this field must be uniform across all selected",
		`packages. The entire run uses one ${field}. Either:`,
		"  - Declare it consistently across packages (typically by inheriting",
		"    from a shared config), OR",
		"  - Pass the CLI override to set a single value for the run.",
	);

	return lines.join("\n");
}

export type { ConsensusSpec, OptionalFieldSpec, PackageConfigEntry, RequiredFieldSpec };
