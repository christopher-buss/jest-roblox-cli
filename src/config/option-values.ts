import type { Backend, CoverageReporter } from "./schema.ts";

export const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
	"auto",
	"open-cloud",
	"studio",
	"studio-cli",
]);

/**
 * Narrow a string to a `Backend`.
 *
 * @param value - Candidate backend name.
 * @returns True when the value is a known backend.
 */
export function isValidBackend(value: string): value is Backend {
	return VALID_BACKENDS.has(value);
}

export const VALID_COVERAGE_REPORTERS: ReadonlySet<string> = new Set<CoverageReporter>([
	"clover",
	"cobertura",
	"html",
	"html-spa",
	"json",
	"json-summary",
	"lcov",
	"lcovonly",
	"none",
	"teamcity",
	"text",
	"text-lcov",
	"text-summary",
]);

/**
 * Narrow a string to a `CoverageReporter`.
 *
 * @param value - Candidate reporter name.
 * @returns True when the value is a known coverage reporter.
 */
export function isCoverageReporter(value: string): value is CoverageReporter {
	return VALID_COVERAGE_REPORTERS.has(value);
}
