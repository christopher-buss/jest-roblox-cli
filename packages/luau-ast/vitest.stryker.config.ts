import { defineConfig, mergeConfig } from "vitest/config";

import { sharedConfig } from "../../vitest.shared.ts";
import { strykerConfig } from "../../vitest.stryker.shared.ts";

export default mergeConfig(
	mergeConfig(sharedConfig, strykerConfig),
	defineConfig({
		test: {
			coverage: { exclude: ["src/luau-compiler-wasm.ts", "src/luau-parser-wasm.ts"] },
		},
	}),
);
