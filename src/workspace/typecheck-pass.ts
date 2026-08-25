import type { WorkspaceRunOptions } from "../config/schema.ts";
import { mergeResults } from "../output.ts";
import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckGroupEntry, TypecheckPassOutcome } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheckPassAsync } from "../typecheck/group-by-tsconfig.ts";
import { runTypecheckAsync } from "../typecheck/runner.ts";
import type { JestResult } from "../types/jest-result.ts";
import type { WorkspaceProjectResult } from "./coverage-attach.ts";
import { writeTypecheckOnlySinksAsync } from "./output-sinks.ts";
import type { PackageTypecheck, TypeTestProject } from "./test-selection.ts";

/**
 * What `runWorkspace` returns: the per-(package, project) runtime `results`
 * plus the merged host-side Type Test result (set only when `test.typecheck`
 * discovered any). `--typecheckOnly` returns empty `results` still carrying
 * `typecheckResult`. `undefined` (not this shape) signals a
 * preflight/empty-package failure.
 */
export interface WorkspaceRunnerOutput {
	/**
	 * Packages a `--bail` run stopped before reaching, named once each. Absent
	 * unless the run bailed, so `results` covers every selected package.
	 */
	bailedPackages?: Array<string> | undefined;
	/**
	 * This run's {@link PreDispatchTiming} halves. Absent when no runtime job
	 * ran — a typecheck-only run stages nothing.
	 */
	coverageMs?: number | undefined;
	results: Array<WorkspaceProjectResult>;
	/** @see {@link WorkspaceRunnerOutput.coverageMs} */
	stagingMs?: number | undefined;
	typecheckResult?: JestResult | undefined;
}

// Outcome of the workspace Type Test pass: the aggregate `outcome` (the merged
// result + timing the existing sinks consume) plus `byPackage`, the merged Type
// Test result keyed by package name. The per-package result files write each
// package's result under every project that owns Type Tests, so they need the
// split the aggregate has already collapsed.
export interface WorkspaceTypecheckPass {
	byPackage: Map<string, JestResult>;
	outcome: TypecheckPassOutcome;
}

interface TypecheckOnlyInput {
	runOptions: WorkspaceRunOptions;
	timing: TimingCollector;
	typecheckByDirectory: Map<string, PackageTypecheck>;
	typeTestEntries: Array<TypecheckGroupEntry>;
	typeTestProjects: Array<TypeTestProject>;
	workspaceRoot: string;
}

// The workspace per-package variant of {@link runTypecheckPass}: each group's
// package-wide `ignoreSourceErrors`/`spawnTimeout` come from
// `typecheckByDirectory` (keyed by `cwd = package`), and `composePackageIdentity`
// stamps the package name onto every file result so two packages'
// identically-named `-d` files stay distinct after the merge.
export async function runWorkspaceTypecheckPassAsync(
	entries: Array<TypecheckGroupEntry>,
	typecheckByDirectory: Map<string, PackageTypecheck>,
): Promise<WorkspaceTypecheckPass> {
	const byPackage = new Map<string, JestResult>();
	const outcome = await runTypecheckPassAsync(entries, async (group) => {
		// Every group's cwd is a package directory recorded in
		// `typecheckByDirectory` in the same loop iteration that pushed the
		// entry, so the lookup is always present.
		// eslint-disable-next-line ts/no-non-null-assertion -- invariant: cwd ∈ typecheckByDirectory
		const policy = typecheckByDirectory.get(group.cwd)!;
		const raw = await runTypecheckAsync({
			files: group.files,
			ignoreSourceErrors: policy.ignoreSourceErrors,
			rootDir: group.cwd,
			spawnTimeout: policy.spawnTimeout,
			timeout: policy.timeout,
			tsconfig: group.tsconfig,
		});
		const stamped = composePackageIdentity(raw, policy.pkg);
		// A package with two distinct-tsconfig groups folds into one per-package
		// result; `mergeResults` returns `stamped` verbatim for the first group.
		byPackage.set(policy.pkg, mergeResults(stamped, byPackage.get(policy.pkg)));
		return stamped;
	});
	return { byPackage, outcome };
}

// Records the tsgo span (when the pass actually ran) and builds the runner
// output from the runtime `results` plus the merged Type Test result. Shared by
// the overlap path (where the pass may be empty — typecheck off) and the
// `--typecheckOnly` short-circuit, so both branches stay exercised regardless of
// which path a given run takes.
export function attachTypecheck(
	results: Array<WorkspaceProjectResult>,
	pass: TypecheckPassOutcome,
	timing: TimingCollector,
): WorkspaceRunnerOutput {
	if (pass.elapsedMs > 0) {
		timing.record("runTypecheck", pass.elapsedMs);
	}

	return {
		results,
		typecheckResult: pass.result,
	};
}

// The `--typecheckOnly` / no-runtime-specs short-circuit: run only the host-side
// Type Test pass, write it to the workspace `outputFile` sink (no runtime side),
// and return it. Skips instrumentation, the synthesized place build, and Open
// Cloud dispatch entirely.
export async function runTypecheckOnlyWorkspaceAsync(
	input: TypecheckOnlyInput,
): Promise<WorkspaceRunnerOutput> {
	const typecheckPass = await runWorkspaceTypecheckPassAsync(
		input.typeTestEntries,
		input.typecheckByDirectory,
	);
	await writeTypecheckOnlySinksAsync({
		runOptions: input.runOptions,
		typecheckByPackage: typecheckPass.byPackage,
		typecheckResult: typecheckPass.outcome.result,
		typeTestProjects: input.typeTestProjects,
		workspaceRoot: input.workspaceRoot,
	});

	return attachTypecheck([], typecheckPass.outcome, input.timing);
}

// `runTypecheck` keys file results by `path.relative(cwd, file)` — package
// relative, so `src/index.spec-d.ts` from two packages would be
// indistinguishable once merged. Prefix the package name (parity with the
// runtime path's `pkg › project` display) so each merged file result carries
// package identity.
function composePackageIdentity(result: JestResult, packageName: string): JestResult {
	return {
		...result,
		testResults: result.testResults.map((file) => {
			return { ...file, testFilePath: `${packageName}/${file.testFilePath}` };
		}),
	};
}
