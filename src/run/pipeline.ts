import type { Except } from "type-fest";

import type { Backend } from "../backends/dispatch-request.ts";
import type { EmptyRunPolicy } from "../discovery/test-plan.ts";
import type { RunProgress } from "../progress/run-progress.ts";
import type { RunResult } from "../results/run-result-types.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "../typecheck/typecheck-groups.ts";
import { assertTypecheckAvailable, recordTypecheckPass } from "../typecheck/typecheck-groups.ts";
import { VERSION } from "../version.ts";
import { emitRunHeader, type RunHeaderInput } from "./run-header.ts";

/** A stage that stopped the run, with the result the run reports. */
export interface RunRefusal {
	/** What the stopped run reports. */
	refused: RunResult;
}

/** What every layout's resolved units carry for the shared stages. */
export interface RunUnits {
	/** Run header fields the units decide. */
	header: Except<RunHeaderInput, "collectCoverage" | "progress" | "version">;
}

/** What every layout's staging returns for the shared stages. */
export interface StagedInputs {
	/** Whether any staged project collects coverage. */
	collectsCoverage: boolean;
}

/** What every layout's test selection carries for the shared stages. */
export interface TestSelection {
	/** Present exactly when the run selected nothing to do. */
	emptiness?: EmptyRunPolicy | undefined;
	/** Runtime jobs selected; none means a host-only Type Test run. */
	runtimeJobCount: number;
	/** Type Test entries selected. */
	typeTestEntries: ReadonlyArray<TypecheckGroupEntry>;
}

/** What every layout's Type Test pass returns. */
export interface TypecheckPass {
	/** Merged result and timing of the pass. */
	outcome: TypecheckPassOutcome;
}

/** The types one layout works in. */
export interface LayoutTypes {
	/** What the runtime dispatch returns. */
	dispatched: unknown;
	/** What test selection returns. */
	selection: TestSelection;
	/** What staging returns. */
	staged: unknown;
	/** What the Type Test pass returns. */
	typecheck: TypecheckPass;
	/** What unit resolution returns. */
	units: RunUnits;
}

/**
 * What a run did, for the layout to build its result from.
 * @template T - Types of the layout.
 */
export interface FinishedRun<T extends LayoutTypes> {
	/** Runtime dispatch output; empty on a Type-Test-only run. */
	dispatched: T["dispatched"];
	/** Test selection of the run. */
	selection: T["selection"];
	/** Staging products; empty on a Type-Test-only run. */
	staged: T["staged"];
	/** Type Test pass of the run. */
	typecheck: T["typecheck"];
	/** Resolved units of the run. */
	units: T["units"];
}

/**
 * The questions where the run modes differ.
 * @template T - Types of the layout.
 */
export interface RunLayout<T extends LayoutTypes> {
	/** Builds the run result. */
	buildResult(run: FinishedRun<T>): Promise<RunResult> | RunResult;
	/** Dispatches the runtime jobs. */
	dispatchAsync(input: {
		backend: Backend;
		selection: T["selection"];
		staged: T["staged"];
	}): Promise<T["dispatched"]>;
	/** What a run with no runtime job dispatched and staged. */
	noRuntime(selection: T["selection"]): Pick<FinishedRun<T>, "dispatched" | "staged">;
	/** Opens the backend of the run. */
	openBackend(units: T["units"]): Backend | Promise<Backend>;
	/** Resolves the projects to run, grouped by unit. */
	resolveUnitsAsync(): Promise<RunRefusal | T["units"]>;
	/** Selects the tests of each project. */
	selectTests(
		units: T["units"],
	): Promise<RunRefusal | T["selection"]> | RunRefusal | T["selection"];
	/** Puts the run's inputs on disk for the backend. */
	stageAsync(input: {
		backend: Backend;
		selection: T["selection"];
	}): Promise<StagedInputs & T["staged"]>;
	/** Runs the host-side Type Test pass. */
	typecheckAsync(selection: T["selection"]): Promise<T["typecheck"]>;
}

/**
 * Run a layout through the stages every mode shares.
 * @template T - Types of the layout.
 * @param layout - The mode's answers.
 * @param instruments - Profiler and stage reporter of the run.
 * @param instruments.progress - Stage reporter the run header reveals.
 * @param instruments.timing - Profiler of the run.
 * @returns The run result.
 */
export async function runPipelineAsync<T extends LayoutTypes>(
	layout: RunLayout<T>,
	{ progress, timing }: { progress: RunProgress; timing: TimingCollector },
): Promise<RunResult> {
	const units = await layout.resolveUnitsAsync();
	if (isRefusal(units)) {
		return units.refused;
	}

	const selection = await layout.selectTests(units);
	if (isRefusal(selection)) {
		return selection.refused;
	}

	assertTypecheckAvailable(selection.typeTestEntries);

	if (selection.emptiness !== undefined) {
		return { coverageMs: 0, projectResults: [], stagingMs: 0, ...selection.emptiness };
	}

	if (selection.runtimeJobCount === 0) {
		const typecheck = await layout.typecheckAsync(selection);
		recordTypecheckPass(timing, typecheck.outcome);
		return layout.buildResult({ ...layout.noRuntime(selection), selection, typecheck, units });
	}

	return layout.buildResult(
		await runOnBackendAsync({ layout, progress, selection, timing, units }),
	);
}

async function runOnBackendAsync<T extends LayoutTypes>({
	layout,
	progress,
	selection,
	timing,
	units,
}: {
	layout: RunLayout<T>;
	progress: RunProgress;
	selection: T["selection"];
	timing: TimingCollector;
	units: T["units"];
}): Promise<FinishedRun<T>> {
	const backend = await timing.profileAsync("resolveBackend", async () => {
		return layout.openBackend(units);
	});
	try {
		const staged = await layout.stageAsync({ backend, selection });
		emitRunHeader({
			...units.header,
			collectCoverage: staged.collectsCoverage,
			progress,
			version: VERSION,
		});
		const [dispatched, typecheck] = await Promise.all([
			layout.dispatchAsync({ backend, selection, staged }),
			layout.typecheckAsync(selection),
		]);
		recordTypecheckPass(timing, typecheck.outcome);
		return { dispatched, selection, staged, typecheck, units };
	} finally {
		await backend.closeAsync?.();
	}
}

function isRefusal(value: object): value is RunRefusal {
	return "refused" in value;
}
