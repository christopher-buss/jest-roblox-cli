/** Host-only Type Test config. Valid at root `test:` and per-project `test:`. */
export interface TypecheckConfig {
	enabled?: boolean;
	exclude?: Array<string>;
	/**
	 * When `false` (default), type errors in non-test source files surface as
	 * source-level failures (vitest parity). When `true`, errors outside the
	 * discovered Type Test files are suppressed.
	 */
	ignoreSourceErrors?: boolean;
	include?: Array<string>;
	only?: boolean;
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

	const tsconfig = cli.tsconfig ?? project.tsconfig ?? root.tsconfig;
	if (tsconfig !== undefined) {
		resolved.tsconfig = tsconfig;
	}

	return resolved;
}
