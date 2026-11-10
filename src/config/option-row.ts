import type { Type } from "arktype";
import type { Except } from "type-fest";

import type { CliOptions } from "./resolved-config.ts";

/** Where an option is written: a config block, or the command line alone. */
export type OptionLocation = "cli" | "project" | "root" | "test-global" | "test-shared";

/** The `--help` group a flag is listed under. */
export type HelpSection =
	| "Backend"
	| "Config"
	| "Coverage"
	| "Filtering"
	| "General"
	| "Open Cloud"
	| "Output"
	| "Type tests"
	| "Workspace";

/** Keys whose config value may be a `(defaults) => merged` function. */
export type MergerKey =
	| "collectCoverageFrom"
	| "coverageCopyIgnorePatterns"
	| "coveragePathIgnorePatterns"
	| "coverageReporters"
	| "coverageThreshold"
	| "formatters"
	| "luauRoots"
	| "reporters"
	| "roots"
	| "selectProjects"
	| "setupFiles"
	| "setupFilesAfterEnv"
	| "snapshotFormat"
	| "snapshotSerializers"
	| "testMatch"
	| "testPathIgnorePatterns";

/** `CliOptions` fields that no config key of the same name carries. */
export type CliOnlyKey =
	| "affectedSince"
	| "apiKey"
	| "bail"
	| "changed"
	| "config"
	| "experimentalVmParallel"
	| "files"
	| "headed"
	| "help"
	| "packages"
	| "project"
	| "related"
	| "typecheck"
	| "typecheckOnly"
	| "typecheckTsconfig"
	| "version"
	| "workspace"
	| "workspaceRoot";

/** A flag once its value type is erased. */
export interface AnyCliFlag extends FlagBase {
	/** Whether the next argument is this flag's value. */
	readonly bare?: (next: string) => boolean;
	/** The flag may be repeated. */
	readonly multiple?: true;
	/** The `--no-` twin that sets the option to `false`. */
	readonly negation?: Negation;
	/** Turns the raw value into the option's value, or throws. */
	readonly parse?: (raw: string) => unknown;
	/** Turns a repeated flag's raw values into the option's value. */
	readonly parseList?: (raw: Array<string>) => unknown;
	/** Value placeholder shown by `--help`; absent for a boolean flag. */
	readonly value?: string;
}

/**
 * One config key's row, checked against the key's declared type.
 *
 * @template K - The config key.
 * @template V - The key's declared value type.
 */
export type ConfigRow<K extends string, V> = (K extends FlaggedConfigKey
	? { readonly cli: CliFlag<NonNullable<CliOptions[K]>> }
	: { readonly cli?: never }) &
	(K extends MergerKey
		? { readonly merger: "array" | "object" }
		: { readonly merger?: never }) & {
		/** Forwarded to Jest's argv. */
		readonly jest?: true;
		/** Validates the key's value. */
		readonly schema: Type<NonNullable<V>>;
		/** How a workspace run settles the key. */
		readonly workspace?: WorkspaceResolution;
	};

/**
 * A CLI-only option's row.
 *
 * @template V - Value type of the option.
 */
export interface CliOnlyRow<V> {
	/** The flag. */
	readonly cli: CliFlag<V>;
	/** How a workspace run settles the option. */
	readonly workspace?: WorkspaceResolution;
}

/** One option of the CLI or config, once its key and location are attached. */
export interface OptionRow {
	/** Option name: the config key, else the `CliOptions` field. */
	readonly key: string;
	/** The flag, when the option has one. */
	readonly cli?: AnyCliFlag;
	/** Forwarded to Jest's argv. */
	readonly jest?: true;
	/** Where the option is written. */
	readonly location: OptionLocation;
	/** The value may be a `(defaults) => merged` function of this kind. */
	readonly merger?: "array" | "object";
	/** Required in a project's `test` block. */
	readonly projectRequired?: true;
	/** Validates the value; absent for a CLI-only option. */
	readonly schema?: Type;
	/** How a workspace run settles the option. */
	readonly workspace?: WorkspaceResolution;
}

interface FlagBase {
	/** Flag name without the leading `--`. */
	readonly name: string;
	readonly bareValue?: string;
	/** One-line description shown by `--help`. */
	readonly help: string;
	/** `--help` group. */
	readonly section: HelpSection;
	/** Single-letter alias without the leading `-`. */
	readonly short?: string;
}

interface Negation {
	/** Flag name without the leading `--`. */
	readonly name: string;
	/** One-line description shown by `--help`. */
	readonly help: string;
}

/**
 * How a workspace run settles one value across its packages: `defaulted` is
 * CLI > consensus > default, `optional` is CLI > consensus > absent,
 * `consensus` has no flag, `custom` has its own resolver, `cli` reads the
 * flag alone.
 */
type WorkspaceResolution = "cli" | "consensus" | "custom" | "defaulted" | "optional";

interface BooleanFlag extends FlagBase {
	/** The `--no-` twin that sets the option to `false`. */
	readonly negation?: Negation;
}

type ListFlag<V> = FlagBase &
	(V extends Array<infer E>
		? string extends E
			? { readonly parseList?: never }
			: { readonly parseList: (raw: Array<string>) => V }
		: never) & { readonly multiple: true; readonly value: string };

type ValueFlag<V> = FlagBase & {
	readonly bare?: (next: string) => boolean;
	readonly value: string;
} & (string extends V ? { readonly parse?: never } : { readonly parse: (raw: string) => V });

type CliFlag<V> = [V] extends [boolean]
	? BooleanFlag
	: [V] extends [Array<unknown>]
		? ListFlag<V>
		: ValueFlag<V>;

type FlaggedConfigKey = Exclude<keyof CliOptions, CliOnlyKey>;

/**
 * Attach a key and location to every row of a table.
 *
 * @param location - Where the table's options are written.
 * @param table - Rows by key.
 * @returns One row per key, in table order.
 */
export function rowsOf(
	location: OptionLocation,
	table: Readonly<Record<string, Except<OptionRow, "key" | "location">>>,
): Array<OptionRow> {
	return Object.entries(table).map(([key, row]) => {
		return { ...row, key, location };
	});
}

/**
 * Build a `+: reject` object definition from rows.
 *
 * @param rows - Rows to include.
 * @param isRequired - Whether a row's key is required.
 * @returns The arktype object definition.
 */
export function objectDefinition(
	rows: ReadonlyArray<OptionRow>,
	isRequired: (row: OptionRow) => boolean = () => false,
): Record<string, unknown> {
	return Object.fromEntries([
		["+", "reject"],
		...rows.map((row): [string, unknown] => {
			return [isRequired(row) ? row.key : `${row.key}?`, row.schema];
		}),
	]);
}
