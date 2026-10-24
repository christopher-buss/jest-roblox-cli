import { join } from "node:path";

import { type PartialStrykerOptions, sharedConfig } from "../../stryker.shared.config.ts";

export default {
	...sharedConfig,
	tsconfigFile: "tsconfig.json",
	vitest: {
		configFile: join(import.meta.dirname, "vitest.stryker.config.ts"),
	},
} satisfies PartialStrykerOptions;
