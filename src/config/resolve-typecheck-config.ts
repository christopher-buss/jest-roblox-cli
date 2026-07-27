/**
 * Host-only Type Test config. Valid at root `test:` and per-project `test:`.
 */
export interface TypecheckConfig {
	/**
	 * Enable Type Tests (`*.spec-d.ts`/`*.test-d.ts`). This is the only gate —
	 * setting other typecheck fields does not auto-enable. Default `false`.
	 */
	enabled?: boolean | undefined;
	/** Globs excluded from Type Test discovery. */
	exclude?: Array<string> | undefined;
	/**
	 * When `false` (default), type errors in non-test source files surface as
	 * source-level failures (vitest parity). When `true`, errors outside the
	 * discovered Type Test files are suppressed.
	 */
	ignoreSourceErrors?: boolean | undefined;
	/**
	 * Globs selecting Type Test files. When unset, derived from the project's
	 * runtime `include` (`.spec.` → `.spec-d.`).
	 */
	include?: Array<string> | undefined;
	/**
	 * Run only Type Tests and skip Runtime Tests. Implies `enabled`. Default
	 * `false`.
	 */
	only?: boolean | undefined;
	/**
	 * Milliseconds to wait for the tsgo process to start before the pass
	 * throws. Bounds only startup, not the type-check itself — a slow check is
	 * governed by the run-level `timeout`. Default `10000`.
	 */
	spawnTimeout?: number | undefined;
	/** Custom tsconfig used for type checking (root-only in projects mode). */
	tsconfig?: string | undefined;
}

/** CLI flags that map onto `test.typecheck.{enabled,only,tsconfig}`. */
export interface TypecheckCliOptions {
	enabled?: boolean | undefined;
	only?: boolean | undefined;
	tsconfig?: string | undefined;
}

export interface TypecheckLayers {
	cli?: TypecheckCliOptions | undefined;
	project?: TypecheckConfig | undefined;
	root?: TypecheckConfig | undefined;
}

export interface ResolvedTypecheckConfig {
	enabled: boolean;
	exclude?: Array<string> | undefined;
	ignoreSourceErrors?: boolean | undefined;
	include?: Array<string> | undefined;
	only: boolean;
	spawnTimeout?: number | undefined;
	tsconfig?: string | undefined;
}

/**
 * Merges the root `test.typecheck`, per-project `test.typecheck`, and CLI
 * typecheck flags into one resolved typecheck config. Precedence per field is
 * CLI > project > root > default. `only` implies `enabled` (mirroring the
 * CLI's `--typecheckOnly`). `include` is never derived here — the caller falls
 * back to `deriveTypecheckInclude(runtimeInclude)` when it is unset.
 */
export function resolveTypecheckConfig({
	cli = {},
	project = {},
	root = {},
}: TypecheckLayers): ResolvedTypecheckConfig {
	const isOnly = cli.only ?? project.only ?? root.only ?? false;
	const isEnabled = (cli.enabled ?? project.enabled ?? root.enabled ?? false) || isOnly;

	const resolved: ResolvedTypecheckConfig = { enabled: isEnabled, only: isOnly };

	const include = project.include ?? root.include;
	if (include !== undefined) {
		resolved.include = include;
	}

	const exclude = project.exclude ?? root.exclude;
	if (exclude !== undefined) {
		resolved.exclude = exclude;
	}

	const shouldIgnoreSourceErrors = project.ignoreSourceErrors ?? root.ignoreSourceErrors;
	if (shouldIgnoreSourceErrors !== undefined) {
		resolved.ignoreSourceErrors = shouldIgnoreSourceErrors;
	}

	const spawnTimeout = project.spawnTimeout ?? root.spawnTimeout;
	if (spawnTimeout !== undefined) {
		resolved.spawnTimeout = spawnTimeout;
	}

	const tsconfig = cli.tsconfig ?? project.tsconfig ?? root.tsconfig;
	if (tsconfig !== undefined) {
		resolved.tsconfig = tsconfig;
	}

	return resolved;
}
