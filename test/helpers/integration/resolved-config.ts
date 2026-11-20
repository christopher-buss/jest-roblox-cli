import type { ResolvedConfig } from "@isentinel/jest-roblox";
import { DEFAULT_CONFIG } from "@isentinel/jest-roblox/api";

export function createResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
	return { ...structuredClone(DEFAULT_CONFIG), ...overrides };
}
