import { fileURLToPath } from "node:url";

import { type PartialStrykerOptions, sharedConfig } from "../../stryker.shared.config.ts";

export default {
	...sharedConfig,
	tsconfigFile: "tsconfig.json",
	vitest: { configFile: fileURLToPath(new URL("./vitest.stryker.config.ts", import.meta.url)) },
} satisfies PartialStrykerOptions;
