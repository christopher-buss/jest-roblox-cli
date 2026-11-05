import { createDefineConfig } from "c12";

import type { Config, FormatterEntry, GlobalTestConfig, InlineProjectConfig } from "./schema.ts";

/**
 * Homomorphic (`[K in keyof T]`) so each property's JSDoc is preserved on
 * hover in a `defineConfig({ … })` literal — the mergeable keys still relax
 * to accept a `(defaults) => merged` function, but TypeScript forwards the
 * source doc comment.
 */
export type ConfigInput = {
	[K in keyof Config]?: K extends "formatters"
		? Mergeable<Array<FormatterEntry>>
		: K extends "luauRoots"
			? Mergeable<Array<string>>
			: K extends "test"
				? GlobalTestConfigInput
				: Config[K];
};

type MergerFunction<T> = (defaults: T) => T;

type Mergeable<T> = MergerFunction<T> | T;

type MergeableTestKey =
	| "collectCoverageFrom"
	| "coverageCopyIgnorePatterns"
	| "coveragePathIgnorePatterns"
	| "coverageReporters"
	| "coverageThreshold"
	| "reporters"
	| "roots"
	| "selectProjects"
	| "setupFiles"
	| "setupFilesAfterEnv"
	| "snapshotFormat"
	| "snapshotSerializers"
	| "testMatch"
	| "testPathIgnorePatterns";

// Homomorphic for the same JSDoc-preservation reason as `ConfigInput`; the
// mergeable keys relax to `Mergeable<…>` while every key keeps its source doc.
type GlobalTestConfigInput = {
	[K in keyof GlobalTestConfig]?: K extends MergeableTestKey
		? Mergeable<NonNullable<GlobalTestConfig[K]>>
		: GlobalTestConfig[K];
};

/**
 * Identity helper for authoring a typed `jest.config.*` file. Returns its
 * input unchanged; it exists purely to give editors autocompletion and
 * type-checking for the root config contract (`Config` plus the c12 layer props
 * on `ConfigInput`).
 *
 * Use it as the default export of a config file discovered by c12 (`.ts`,
 * `.js`, `.mjs`, `.cjs`, `.json`, `.yaml`, `.toml`). All jest-passthrough
 * options live under the `test:` block; root keys are CLI/runner-level.
 * Configs may extend a shared base via `extends`, and any `Mergeable` array
 * field (e.g. `test.testMatch`) accepts a function that receives the inherited
 * defaults and returns the merged value. Precedence is CLI flags > config file
 * > extended config > defaults.
 */
export const defineConfig: (input: ConfigInput) => ConfigInput = createDefineConfig<ConfigInput>();

/**
 * Identity helper for a single entry inside `test.projects`, mirroring
 * {@link defineConfig} for per-project overrides. Returns its input unchanged
 * and exists only for editor autocompletion and type-checking of the
 * `InlineProjectConfig` contract — a `test:` block carrying the project's
 * `include`/`displayName` plus any shared per-project jest options.
 */
export const defineProject: (input: InlineProjectConfig) => InlineProjectConfig =
	createDefineConfig<InlineProjectConfig>();
