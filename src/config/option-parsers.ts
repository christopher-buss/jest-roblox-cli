import type { BackendName, CoverageReporter } from "./config-types.ts";
import { FORMATTER_NAMES, type FormatterName } from "./formatter-selection.ts";
import {
	BACKENDS,
	COVERAGE_REPORTERS,
	isCoverageReporter,
	isValidBackend,
} from "./option-values.ts";
import type { ParallelCount } from "./resolved-config.ts";

const INTEGER_LIKE_PATTERN = /^-?\d+$/;

export const BARE_FLAG_VALUE = "auto";

/**
 * Parser for a flag whose value is a positive integer.
 *
 * @param flag - Flag name, for the error.
 * @returns The parser.
 */
export function parsePositiveInteger(flag: string): (raw: string) => number {
	return (raw) => {
		const parsed = Number(raw);
		if (!INTEGER_LIKE_PATTERN.test(raw) || parsed < 1) {
			throw new Error(`Invalid --${flag} value "${raw}". Must be a positive integer.`);
		}

		return parsed;
	};
}

/**
 * Parse a backend name.
 *
 * @param raw - Flag value.
 * @returns The backend it names.
 * @throws If the name is not a backend.
 */
export function parseBackend(raw: string): BackendName {
	if (!isValidBackend(raw)) {
		throw new Error(`Invalid backend "${raw}". Must be one of: ${BACKENDS.join(", ")}`);
	}

	return raw;
}

/**
 * Parse coverage reporter names.
 *
 * @param values - Flag values.
 * @returns The reporters, in flag order.
 * @throws Naming every value that is not a reporter.
 */
export function parseCoverageReporters(values: Array<string>): Array<CoverageReporter> {
	const reporters = values.filter(isCoverageReporter);
	if (reporters.length !== values.length) {
		const unknown = values.filter((value) => !isCoverageReporter(value));
		throw new Error(
			`Invalid coverage reporter "${unknown.join('", "')}". Must be one of: ${COVERAGE_REPORTERS.join(", ")}`,
		);
	}

	return reporters;
}

/**
 * Whether the argument after a bare count flag is its value.
 *
 * @param next - The next argument.
 * @returns True for `auto` or an integer.
 */
export function isCountValue(next: string): boolean {
	return next === BARE_FLAG_VALUE || INTEGER_LIKE_PATTERN.test(next);
}

/**
 * Parse a `--parallel` value.
 *
 * @param raw - Flag value; `auto` when written bare.
 * @returns `"auto"` or the session count.
 * @throws If the value is not `auto` or a positive integer.
 */
export function parseParallel(raw: string): ParallelCount {
	if (raw === BARE_FLAG_VALUE) {
		return "auto";
	}

	const parsed = Number(raw);
	if (!INTEGER_LIKE_PATTERN.test(raw) || parsed < 1) {
		throw new Error(`Invalid --parallel value "${raw}". Must be a positive integer or "auto".`);
	}

	return parsed;
}

/**
 * Parse an `--experimental-vm-parallel` value.
 *
 * @param raw - Flag value; `auto` when written bare.
 * @returns `"auto"` or the VM count.
 * @throws If the value is not `auto` or a positive integer.
 */
export function parseVmParallel(raw: string): ParallelCount {
	if (raw === BARE_FLAG_VALUE) {
		return "auto";
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) {
		throw new Error(
			`Invalid --experimental-vm-parallel value "${raw}". Must be a positive integer.`,
		);
	}

	return parsed;
}

/**
 * Parse `--formatters` values, rejecting any name no formatter has.
 *
 * @param values - Flag values.
 * @returns The formatters, in flag order.
 * @throws Naming every value that is not a formatter.
 */
export function parseFormatterNames(values: Array<string>): Array<FormatterName> {
	const names = values.filter(isFormatterName);
	if (names.length !== values.length) {
		const unknown = values.filter((value) => !isFormatterName(value));
		throw new Error(
			`Invalid formatter "${unknown.join('", "')}". Must be one of: ${FORMATTER_NAMES.join(", ")}`,
		);
	}

	return names;
}

function isFormatterName(value: string): value is FormatterName {
	return (FORMATTER_NAMES as ReadonlyArray<string>).includes(value);
}
