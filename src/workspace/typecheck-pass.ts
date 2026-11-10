import type { UnitTypecheckResult } from "../results/run-result-types.ts";
import type { RunTypecheck } from "../typecheck/runner.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "../typecheck/typecheck-groups.ts";
import { runPolicyTypecheckPassAsync } from "../typecheck/typecheck-groups.ts";
import { mergeResults } from "../types/jest-result-merge.ts";
import type { JestResult } from "../types/jest-result-types.ts";
import type { WorkspaceProjectResult } from "./coverage-attach.ts";
import type { PackageTypecheck } from "./test-selection.ts";

/** What a workspace run produced. */
export interface WorkspaceRunnerOutput {
	/** Packages a `--bail` run stopped before reaching. */
	bailedPackages: Array<string>;
	/** Coverage preparation time. */
	coverageMs: number;
	/** Runtime result of each (package, project) pair. */
	results: Array<WorkspaceProjectResult>;
	/** Staging time. */
	stagingMs: number;
	/** Merged Type Test result, when the pass discovered any. */
	typecheckResult?: JestResult | undefined;
	/** Type Test result of each (package, project) pair. */
	typecheckUnits?: Array<UnitTypecheckResult> | undefined;
}

/** Outcome of the workspace Type Test pass. */
export interface WorkspaceTypecheckPass {
	/** Merged Type Test result per package name. */
	byPackage: Map<string, JestResult>;
	/** Aggregate result and timing of the pass. */
	outcome: TypecheckPassOutcome;
}

/**
 * Run the Type Test pass with per-package policy.
 * @param options - Type checker and Type Test groups.
 * @param options.runTypecheck - Type checker to run each group through.
 * @param options.typecheckByDirectory - Type Test policy per package directory.
 * @param options.typeTestEntries - Type Test files to group.
 * @returns The aggregate outcome and the result per package.
 * @rejects When the type checker fails.
 */
export async function runWorkspaceTypecheckPassAsync({
	runTypecheck,
	typecheckByDirectory,
	typeTestEntries: entries,
}: {
	/** Type checker to run each group through. */
	readonly runTypecheck: RunTypecheck;
	/** Type Test policy per package directory. */
	readonly typecheckByDirectory: Map<string, PackageTypecheck>;
	/** Type Test files to group. */
	readonly typeTestEntries: Array<TypecheckGroupEntry>;
}): Promise<WorkspaceTypecheckPass> {
	const byPackage = new Map<string, JestResult>();
	const outcome = await runPolicyTypecheckPassAsync({
		entries,
		finishGroup: (raw, policy: PackageTypecheck) => {
			const stamped = composePackageIdentity(raw, policy.pkg);
			byPackage.set(policy.pkg, mergeResults(stamped, byPackage.get(policy.pkg)));
			return stamped;
		},
		policyByDirectory: typecheckByDirectory,
		runTypecheck,
	});
	return { byPackage, outcome };
}

function composePackageIdentity(result: JestResult, packageName: string): JestResult {
	return {
		...result,
		testResults: result.testResults.map((file) => {
			return { ...file, testFilePath: `${packageName}/${file.testFilePath}` };
		}),
	};
}
