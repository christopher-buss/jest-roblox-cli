import { createResolvedConfig } from "#test/mocks/resolved-config.ts";
import type { ResolvedProjectConfig } from "../../src/config/projects.ts";
import type { ResolvedConfig } from "../../src/config/schema.ts";

export function makeResolvedProject(
	overrides: Partial<ResolvedProjectConfig> = {},
): ResolvedProjectConfig {
	const config: ResolvedConfig = {
		...createResolvedConfig(),
		rootDir: "/root",
	};
	return {
		config,
		displayName: "client",
		exclude: [],
		include: ["src/client/**/*.spec.ts"],
		outDir: "out/client",
		projects: ["ReplicatedStorage/client"],
		rojoMounts: [{ dataModelPath: "ReplicatedStorage/client", fsPath: "out/client" }],
		testMatch: ["**/*.spec"],
		...overrides,
	};
}
