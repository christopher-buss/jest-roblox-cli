/** Host-only Type Test config. Valid at root `test:` and per-project `test:`. */
export interface TypecheckConfig {
	/**
	 * Enable Type Tests (`*.spec-d.ts`/`*.test-d.ts`). This is the only gate —
	 * setting other typecheck fields does not auto-enable. Default `false`.
	 */
	enabled?: boolean;
	/** Globs excluded from Type Test discovery. */
	exclude?: Array<string>;
	/**
	 * When `false` (default), type errors in non-test source files surface as
	 * source-level failures (vitest parity). When `true`, errors outside the
	 * discovered Type Test files are suppressed.
	 */
	ignoreSourceErrors?: boolean;
	/**
	 * Globs selecting Type Test files. When unset, derived from the project's
	 * runtime `include` (`.spec.` → `.spec-d.`).
	 */
	include?: Array<string>;
	/** Run only Type Tests and skip Runtime Tests. Implies `enabled`. Default `false`. */
	only?: boolean;
	/**
	 * Milliseconds to wait for the tsgo process to start before the pass
	 * throws. Bounds only startup, not the type-check itself — a slow check is
	 * governed by the run-level `timeout`. Default `10000`.
	 */
	spawnTimeout?: number;
	/** Custom tsconfig used for type checking (root-only in projects mode). */
	tsconfig?: string;
}

/** CLI flags that map onto `test.typecheck.{enabled,only,tsconfig}`. */
export interface TypecheckCliOptions {
	enabled?: boolean;
	only?: boolean;
	tsconfig?: string;
}

export interface TypecheckLayers {
	cli?: TypecheckCliOptions;
	project?: TypecheckConfig;
	root?: TypecheckConfig;
}

export interface ResolvedTypecheckConfig {
	enabled: boolean;
	exclude?: Array<string>;
	ignoreSourceErrors?: boolean;
	include?: Array<string>;
	only: boolean;
	spawnTimeout?: number;
	tsconfig?: string;
}

/**
 * Merges the root `test.typecheck`, per-project `test.typecheck`, and CLI
 * typecheck flags into one resolved typecheck config. Precedence per field is
 * CLI > project > root > default. `only` implies `enabled` (mirroring the CLI's
 * `--typecheckOnly`). `include` is never derived here — the caller falls back to
 * `deriveTypecheckInclude(runtimeInclude)` when it is unset.
 */
export function resolveTypecheckConfig(layers: TypecheckLayers): ResolvedTypecheckConfig {
	const { cli = {}, project = {}, root = {} } = layers;

	const only = cli.only ?? project.only ?? root.only ?? false;
	const enabled = (cli.enabled ?? project.enabled ?? root.enabled ?? false) || only;

	const resolved: ResolvedTypecheckConfig = { enabled, only };

	const include = project.include ?? root.include;
	if (include !== undefined) {
		resolved.include = include;
	}

	const exclude = project.exclude ?? root.exclude;
	if (exclude !== undefined) {
		resolved.exclude = exclude;
	}

	const ignoreSourceErrors = project.ignoreSourceErrors ?? root.ignoreSourceErrors;
	if (ignoreSourceErrors !== undefined) {
		resolved.ignoreSourceErrors = ignoreSourceErrors;
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
