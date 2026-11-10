import { createDefineConfig } from "c12";

import type { Config, GlobalTestConfig, InlineProjectConfig } from "./config-types.ts";
import type { MergerKey } from "./option-row.ts";

/** Config file input; homomorphic so each key keeps its JSDoc on hover. */
export type ConfigInput = {
	[K in keyof Config]?: K extends "test"
		? GlobalTestConfigInput
		: K extends MergerKey
			? Mergeable<NonNullable<Config[K]>>
			: Config[K];
};

type MergerFunction<T> = (defaults: T) => T;

type Mergeable<T> = MergerFunction<T> | T;

// Homomorphic so each key keeps its JSDoc on hover.
type GlobalTestConfigInput = {
	[K in keyof GlobalTestConfig]?: K extends MergerKey
		? Mergeable<NonNullable<GlobalTestConfig[K]>>
		: GlobalTestConfig[K];
};

/** Identity helper that types a `jest.config.*` file. */
export const defineConfig: (input: ConfigInput) => ConfigInput = createDefineConfig<ConfigInput>();

/** Identity helper that types one `test.projects` entry. */
export const defineProject: (input: InlineProjectConfig) => InlineProjectConfig =
	createDefineConfig<InlineProjectConfig>();
