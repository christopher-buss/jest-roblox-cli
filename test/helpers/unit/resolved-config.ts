import type { ResolvedConfig } from "#src/config/resolved-config.ts";
import { DEFAULT_CONFIG } from "#src/config/resolved-config.ts";

export function createResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}
