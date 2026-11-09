import type { ParseArgsOptionsConfig } from "node:util";
import { parseArgs as nodeParseArgs } from "node:util";

import {
	isCoverageReporter,
	isValidBackend,
	VALID_BACKENDS,
	VALID_COVERAGE_REPORTERS,
} from "./config/option-values.ts";
import type { Backend, CliOptions, CoverageReporter } from "./config/schema.ts";
import {
	CHANGED_FLAG,
	normalizeOptionalValueFlags,
	parseParallelValue,
	parseVmParallelValue,
} from "./optional-value-flags.ts";

// `as const` is what keeps the per-flag `type`/`multiple`/`default` literals —
// node's `parseArgs` types derive the shape of `values` from them, so widening
// any of these to `string`/`boolean` would collapse every parsed value to
// `string | boolean | undefined`.
const CLI_OPTION_SPEC = {
	"affected-since": { type: "string" },
	"apiKey": { type: "string" },
	"backend": { type: "string" },
	"bail": { type: "boolean" },
	"changed": { type: "string" },
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

const RELATED_COMMAND = "related";

interface CliParseConfig {
	allowPositionals: true;
	args: Array<string>;
	options: typeof CLI_OPTION_SPEC;
	strict: true;
}

type ParsedCliValues = ReturnType<typeof parseWithOptionSpec>["values"];

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
	| "changed"
	| "files"
	| "passWithNoTests"
	| "project"
	| "related"
	| "testNamePattern"
	| "testPathPattern"
> {
	const [command, ...relatedFiles] = positionals;
	const isRelated = command === RELATED_COMMAND;
	if (isRelated && relatedFiles.length === 0) {
		throw new Error(`${RELATED_COMMAND} needs at least one source file.`);
	}

	const { changed } = values;
	if (changed?.startsWith("-") === true) {
		throw new Error(`Invalid ${CHANGED_FLAG} ref "${changed}".`);
	}

	if (isRelated && changed !== undefined) {
		throw new Error(`${RELATED_COMMAND} and ${CHANGED_FLAG} cannot be used together.`);
	}

	const isPartialRun = isRelated || changed !== undefined;
	return {
		changed,
		files: !isRelated && positionals.length > 0 ? positionals : undefined,
		passWithNoTests: values.passWithNoTests ?? (isPartialRun ? true : undefined),
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
