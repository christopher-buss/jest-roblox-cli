import * as path from "node:path";
import process from "node:process";
import { isDefined, pickBy } from "remeda";

import { defaultFormatters } from "./default-formatters.ts";
import type { FormatterEntry } from "./formatter-selection.ts";
import type { OptionRow } from "./option-row.ts";
import { CONFIG_ROWS } from "./options.ts";
import type { CliOptions, WorkspaceRunOptions } from "./resolved-config.ts";
import { DEFAULT_CONFIG } from "./resolved-config.ts";
import type {
	ConsensusSpec,
	FieldSources,
	OptionalFieldSpec,
	PackageConfigEntry,
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

type TableResolution = "consensus" | "defaulted" | "optional";

function rowsResolvedBy(resolution: TableResolution): ReadonlyArray<OptionRow> {
	return CONFIG_ROWS.filter((row) => row.workspace === resolution);
}

function specOf(row: OptionRow): OptionalFieldSpec<unknown> {
	return {
		name: row.key,
		readCli: (entry) => Reflect.get(entry, row.key),
		readConfig: (entry) => {
			return Reflect.get(row.location === "root" ? entry : (entry.test ?? {}), row.key);
		},
	};
}

function resolveTableFields(sources: FieldSources): Record<string, unknown> {
	const defaulted = rowsResolvedBy("defaulted").map((row): [string, unknown] => [
		row.key,
		resolveField({
			...sources,
			spec: { ...specOf(row), default: Reflect.get(DEFAULT_CONFIG, row.key) },
		}),
	]);
	const optional = rowsResolvedBy("optional").map((row): [string, unknown] => [
		row.key,
		resolveOptionalField({ ...sources, spec: specOf(row) }),
	]);
	const consensus = rowsResolvedBy("consensus").map((row): [string, unknown] => [
		row.key,
		computeConsensus(sources.perPackageConfigs, specOf(row)),
	]);
	return Object.fromEntries([...defaulted, ...optional, ...consensus]);
}

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

/**
 * Whether Studio can launch hidden on this platform, and so does by default.
 *
 * @param platform - Host platform.
 * @returns True on Windows and macOS.
 */
export function isHiddenDesktopPlatform(platform: NodeJS.Platform): boolean {
	return platform === "win32" || platform === "darwin";
}

/**
 * Resolve the run-wide options a workspace run shares across its packages.
 *
 * @param options - CLI flags, package configs, platform and workspace root.
 * @returns The resolved settings shared by every package in the run.
 * @throws If packages disagree on a uniform field.
 */
export function buildWorkspaceRunOptions({
	cli,
	perPackageConfigs,
	platform = process.platform,
	workspaceRoot = process.cwd(),
}: BuildWorkspaceRunOptionsInput): WorkspaceRunOptions {
	const sources = { cli, perPackageConfigs };
	const table = resolveTableFields(sources);
	const resolved = {
		...table,
		...resolveConsensusOnlyFields(perPackageConfigs),
		bail: cli.bail === true,
		experimentalVmParallel: cli.experimentalVmParallel,
		formatters: resolveFormatters(cli, perPackageConfigs),
		gameOutput: resolveAggregateArtifactPath({
			defaultName: "game-output.log",
			value: table["gameOutput"],
			workspaceRoot,
		}),
		hiddenDesktop: resolveOptionalField({
			...sources,
			spec: hiddenDesktopSpec({ perPackageConfigs, platform }),
		}),
		outputFile: resolveAggregateArtifactPath({
			defaultName: "jest-output.log",
			value: table["outputFile"],
			workspaceRoot,
		}),
		timeout: resolveTimeout(sources),
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the table fields come from rows whose schemas are checked against Config
	return pickBy(resolved, isDefined) as WorkspaceRunOptions;
}

function resolveTimeout({ cli, perPackageConfigs }: FieldSources): number {
	return (
		cli.timeout ??
		Math.max(...perPackageConfigs.map(({ config }) => config.timeout ?? DEFAULT_CONFIG.timeout))
	);
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
	const isHiddenByDefault = isHiddenDesktopPlatform(platform);
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

function resolveAggregateArtifactPath({
	defaultName,
	value,
	workspaceRoot,
}: {
	readonly defaultName: string;
	readonly value: unknown;
	readonly workspaceRoot: string;
}): string | undefined {
	if (typeof value !== "string" && value !== true) {
		return undefined;
	}

	const target = value === true ? defaultName : value;
	return path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
}
