import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs as nodeParseArgs } from "node:util";

import type { ParallelOption } from "./backends/interface.ts";
import {
	isCoverageReporter,
	isValidBackend,
	VALID_BACKENDS,
	VALID_COVERAGE_REPORTERS,
} from "./config/option-values.ts";
import type { Backend, CliOptions, CoverageReporter } from "./config/schema.ts";

// `as const` is what keeps the per-flag `type`/`multiple`/`default` literals —
// node's `parseArgs` types derive the shape of `values` from them, so widening
// any of these to `string`/`boolean` would collapse every parsed value to
// `string | boolean | undefined`.
const CLI_OPTION_SPEC = {
	"affected-since": { type: "string" },
	"apiKey": { type: "string" },
	"backend": { type: "string" },
	"bail": { type: "boolean" },
	"collectCoverageFrom": { multiple: true, type: "string" },
	"color": { type: "boolean" },
	"config": { type: "string" },
	"coverage": { type: "boolean" },
	"coverage-cache": { type: "boolean" },
	"coverageDirectory": { type: "string" },
	"coverageReporters": { multiple: true, type: "string" },
	"experimental-vm-parallel": { type: "string" },
	"formatters": { multiple: true, type: "string" },
	"gameOutput": { type: "string" },
	"headed": { type: "boolean" },
	"help": { default: false, type: "boolean" },
	"hiddenDesktop": { type: "boolean" },
	"no-color": { type: "boolean" },
	"no-coverage": { type: "boolean" },
	"no-coverage-cache": { type: "boolean" },
	"no-hiddenDesktop": { type: "boolean" },
	"no-show-luau": { type: "boolean" },
	"no-upload-cache": { type: "boolean" },
	"outputFile": { type: "string" },
	"packages": { type: "string" },
	"parallel": { type: "string" },
	"passWithNoTests": { type: "boolean" },
	"placeId": { type: "string" },
	"port": { type: "string" },
	"project": { multiple: true, type: "string" },
	"rojoProject": { type: "string" },
	"setupFiles": { multiple: true, type: "string" },
	"setupFilesAfterEnv": { multiple: true, type: "string" },
	"showLuau": { type: "boolean" },
	"silent": { type: "boolean" },
	"sourceMap": { type: "boolean" },
	"studioPath": { type: "string" },
	"testNamePattern": { short: "t", type: "string" },
	"testPathPattern": { type: "string" },
	"timeout": { type: "string" },
	"typecheck": { type: "boolean" },
	"typecheckOnly": { type: "boolean" },
	"typecheckTsconfig": { type: "string" },
	"universeId": { type: "string" },
	"updateSnapshot": { short: "u", type: "boolean" },
	"upload-cache": { type: "boolean" },
	"verbose": { type: "boolean" },
	"version": { default: false, type: "boolean" },
	"workspace": { type: "boolean" },
	"workspace-root": { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

/**
 * Parse the CLI argument list into options.
 * @param args - Arguments after the executable and script path.
 * @returns The parsed CLI options.
 */
export function parseArgs(args: Array<string>): CliOptions {
	const { positionals, values } = parseWithOptionSpec(args);

	// Spread order matters: `toBackendOptions` and `toCoverageOptions` are the
	// only groups that validate, and they run ahead of the inline `parallel`
	// entry so a run with several bad flags reports the same one it always has.
	return {
		...toBackendOptions(values),
		...toCoverageOptions(values),
		...toFilterOptions(values, positionals),
		...toOutputOptions(values),
		...toTypecheckOptions(values),
		affectedSince: values["affected-since"],
		bail: values.bail,
		config: values.config,
		experimentalVmParallel: parseVmParallelValue(values["experimental-vm-parallel"]),
		help: values.help,
		packages: values.packages,
		parallel: parseParallelValue(values.parallel),
		rojoProject: values.rojoProject,
		setupFiles: values.setupFiles,
		setupFilesAfterEnv: values.setupFilesAfterEnv,
		updateSnapshot: values.updateSnapshot,
		uploadCache: values["no-upload-cache"] === true ? false : values["upload-cache"],
		version: values.version,
		workspace: values.workspace,
		workspaceRoot: values["workspace-root"],
	};
}

const PARALLEL_FLAG = "--parallel";
const VM_PARALLEL_FLAG = "--experimental-vm-parallel";
const INTEGER_LIKE_PATTERN = /^-?\d+$/;

/**
 * The flags whose value is optional: `--parallel` and
 * `--experimental-vm-parallel` both mean "pick the count for me" when written
 * bare. `parseArgs` has no optional-value mode, so the bare form is rewritten
 * to an explicit `auto` before it gets there.
 *
 * `isValueLike` decides what counts as this flag's value rather than the next
 * argument: anything else (a following flag, a positional test path) leaves
 * the flag bare.
 */
const OPTIONAL_VALUE_FLAGS: ReadonlyArray<{
	isValueLike: (next: string) => boolean;
	name: string;
}> = [
	{
		name: PARALLEL_FLAG,
		isValueLike: (next) => next === "auto" || INTEGER_LIKE_PATTERN.test(next),
	},
	{
		name: VM_PARALLEL_FLAG,
		isValueLike: (next) => next === BARE_FLAG_VALUE || INTEGER_LIKE_PATTERN.test(next),
	},
];

const BARE_FLAG_VALUE = "auto";
const RELATED_COMMAND = "related";

interface CliParseConfig {
	allowPositionals: true;
	args: Array<string>;
	options: typeof CLI_OPTION_SPEC;
	strict: true;
}

type ParsedCliValues = ReturnType<typeof parseWithOptionSpec>["values"];

function normalizeOptionalValueFlags(args: Array<string>): Array<string> {
	const out: Array<string> = [];
	for (let index = 0; index < args.length; index++) {
		// oxlint-disable-next-line typescript/no-non-null-assertion -- index bounded by args.length
		const current = args[index]!;
		const flag = OPTIONAL_VALUE_FLAGS.find((entry) => entry.name === current);
		if (flag === undefined) {
			out.push(current);
			continue;
		}

		const next = args[index + 1];
		if (next !== undefined && !next.startsWith("-") && flag.isValueLike(next)) {
			out.push(flag.name, next);
			index += 1;
		} else {
			out.push(flag.name, BARE_FLAG_VALUE);
		}
	}

	return out;
}

function parseWithOptionSpec(
	args: Array<string>,
): ReturnType<typeof nodeParseArgs<CliParseConfig>> {
	return nodeParseArgs({
		allowPositionals: true,
		args: normalizeOptionalValueFlags(args),
		options: CLI_OPTION_SPEC,
		strict: true,
	});
}

function validateBackend(value: string | undefined): Backend | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!isValidBackend(value)) {
		const valid = [...VALID_BACKENDS].join(", ");
		throw new Error(`Invalid backend "${value}". Must be one of: ${valid}`);
	}

	return value;
}

function toBackendOptions(
	values: ParsedCliValues,
): Pick<
	CliOptions,
	| "apiKey"
	| "backend"
	| "headed"
	| "hiddenDesktop"
	| "placeId"
	| "port"
	| "studioPath"
	| "timeout"
	| "universeId"
> {
	return {
		apiKey: values.apiKey,
		backend: validateBackend(values.backend),
		headed: values.headed,
		hiddenDesktop: values["no-hiddenDesktop"] === true ? false : values.hiddenDesktop,
		placeId: values.placeId,
		port: values.port !== undefined ? Number.parseInt(values.port, 10) : undefined,
		studioPath: values.studioPath,
		timeout: values.timeout !== undefined ? Number.parseInt(values.timeout, 10) : undefined,
		universeId: values.universeId,
	};
}

function validateCoverageReporters(
	values: Array<string> | undefined,
): Array<CoverageReporter> | undefined {
	if (values === undefined) {
		return undefined;
	}

	const reporters = values.filter(isCoverageReporter);
	if (reporters.length !== values.length) {
		const valid = [...VALID_COVERAGE_REPORTERS].join(", ");
		const unknown = values.filter((value) => !isCoverageReporter(value));
		throw new Error(
			`Invalid coverage reporter "${unknown.join('", "')}". Must be one of: ${valid}`,
		);
	}

	return reporters;
}

function toCoverageOptions(
	values: ParsedCliValues,
): Pick<
	CliOptions,
	| "collectCoverage"
	| "collectCoverageFrom"
	| "coverageCache"
	| "coverageDirectory"
	| "coverageReporters"
> {
	return {
		collectCoverage: values["no-coverage"] === true ? false : values.coverage,
		collectCoverageFrom: values.collectCoverageFrom,
		coverageCache: values["no-coverage-cache"] === true ? false : values["coverage-cache"],
		coverageDirectory: values.coverageDirectory,
		coverageReporters: validateCoverageReporters(values.coverageReporters),
	};
}

function toFilterOptions(
	values: ParsedCliValues,
	positionals: Array<string>,
): Pick<
	CliOptions,
	"files" | "passWithNoTests" | "project" | "related" | "testNamePattern" | "testPathPattern"
> {
	const [command, ...relatedFiles] = positionals;
	const isRelated = command === RELATED_COMMAND;
	if (isRelated && relatedFiles.length === 0) {
		throw new Error(`${RELATED_COMMAND} needs at least one source file.`);
	}

	return {
		files: !isRelated && positionals.length > 0 ? positionals : undefined,
		passWithNoTests: values.passWithNoTests ?? (isRelated ? true : undefined),
		project: values.project,
		related: isRelated ? relatedFiles : undefined,
		testNamePattern: values.testNamePattern,
		testPathPattern: values.testPathPattern,
	};
}

function toOutputOptions(
	values: ParsedCliValues,
): Pick<
	CliOptions,
	| "color"
	| "formatters"
	| "gameOutput"
	| "outputFile"
	| "showLuau"
	| "silent"
	| "sourceMap"
	| "verbose"
> {
	return {
		color: values["no-color"] === true ? false : values.color,
		formatters: values.formatters,
		gameOutput: values.gameOutput,
		outputFile: values.outputFile,
		showLuau: values["no-show-luau"] === true ? false : values.showLuau,
		silent: values.silent,
		sourceMap: values.sourceMap,
		verbose: values.verbose,
	};
}

function toTypecheckOptions(
	values: ParsedCliValues,
): Pick<CliOptions, "typecheck" | "typecheckOnly" | "typecheckTsconfig"> {
	return {
		typecheck: values.typecheckOnly === true ? true : values.typecheck,
		typecheckOnly: values.typecheckOnly,
		typecheckTsconfig: values.typecheckTsconfig,
	};
}

function parseParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === "auto") {
		return "auto";
	}

	if (!INTEGER_LIKE_PATTERN.test(raw)) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	const parsed = Number(raw);
	if (parsed < 1) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	return parsed;
}

/**
 * `--experimental-vm-parallel [n]`: how many Luau VMs the Studio plugin splits
 * the run's configs across. Bare — or the `auto` the bare form is rewritten to,
 * which a user may also type — means one VM per config; an explicit count must
 * be a positive integer, and the plugin clamps it to the configs it was given
 * and the hosts it ships.
 *
 * @param raw - The flag value, or `undefined` when the flag is absent.
 * @returns `undefined` when absent, `"auto"` when bare, else the count.
 * @throws {Error} When the value is not a positive integer.
 */
function parseVmParallelValue(raw: string | undefined): ParallelOption {
	if (raw === undefined) {
		return undefined;
	}

	if (raw === BARE_FLAG_VALUE) {
		return "auto";
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) {
		throw new Error(`Invalid ${VM_PARALLEL_FLAG} value "${raw}". Must be a positive integer.`);
	}

	return parsed;
}
