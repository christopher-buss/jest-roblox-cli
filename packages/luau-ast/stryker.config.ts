import { fileURLToPath } from "node:url";

import { type PartialStrykerOptions, sharedConfig } from "../../stryker.shared.config.ts";

const config: PartialStrykerOptions = {
	...sharedConfig,
	mutate: [
		...(sharedConfig.mutate ?? []),
		"!src/luau-compiler-wasm.ts",
		"!src/luau-parser-wasm.ts",
	],
	tsconfigFile: "tsconfig.json",
	vitest: {
		configFile: fileURLToPath(new URL("./vitest.stryker.config.ts", import.meta.url)),
	},
};

export default config;
