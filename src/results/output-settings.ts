import type { OutputSettings, RunCoverage } from "./run-result-types.ts";

/** The render settings a run reads from its config or workspace options. */
export type OutputSource = Partial<Pick<OutputSettings, "formatters">> &
	Pick<
		OutputSettings,
		| "color"
		| "gameOutput"
		| "outputFile"
		| "showLuau"
		| "silent"
		| "slowTestThreshold"
		| "verbose"
	>;

/** What the run itself decides about its output. */
export type OutputRunFacts = Pick<
	OutputSettings,
	"perUnitGameOutput" | "perUnitOutputFile" | "rootDir"
> & {
	/** The run's coverage report, if it produced one. */
	coverage: RunCoverage | undefined;
};

/**
 * The output settings of a run in either mode.
 *
 * @param source - Render settings from the run's config or workspace options.
 * @param run - Coverage, root and per-unit sinks of the run.
 * @returns Settings the output layer renders and writes sinks from.
 */
export function toOutputSettings(source: OutputSource, run: OutputRunFacts): OutputSettings {
	return {
		collectCoverage: run.coverage !== undefined,
		color: source.color,
		formatters: source.formatters,
		gameOutput: source.gameOutput,
		outputFile: source.outputFile,
		perUnitGameOutput: run.perUnitGameOutput,
		perUnitOutputFile: run.perUnitOutputFile,
		rootDir: run.rootDir,
		showLuau: source.showLuau,
		silent: source.silent,
		slowTestThreshold: source.slowTestThreshold,
		verbose: source.verbose,
	};
}
