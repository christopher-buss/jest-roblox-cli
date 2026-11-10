import type { BackendName, CoverageReporter } from "./config-types.ts";

const BACKEND_NAMES: Record<BackendName, true> = {
	"auto": true,
	"open-cloud": true,
	"studio": true,
	"studio-cli": true,
};

export const BACKENDS: ReadonlyArray<BackendName> =
	Object.keys(BACKEND_NAMES).filter(isValidBackend);

/**
 * Narrow a string to a `BackendName`.
 *
 * @param value - Candidate backend name.
 * @returns True when the value is a known backend.
 */
export function isValidBackend(value: string): value is BackendName {
	return Object.hasOwn(BACKEND_NAMES, value);
}

export const COVERAGE_REPORTERS: ReadonlyArray<CoverageReporter> = [
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
];

const VALID_COVERAGE_REPORTERS: ReadonlySet<string> = new Set<CoverageReporter>(COVERAGE_REPORTERS);

/**
 * Narrow a string to a `CoverageReporter`.
 *
 * @param value - Candidate reporter name.
 * @returns True when the value is a known coverage reporter.
 */
export function isCoverageReporter(value: string): value is CoverageReporter {
	return VALID_COVERAGE_REPORTERS.has(value);
}
