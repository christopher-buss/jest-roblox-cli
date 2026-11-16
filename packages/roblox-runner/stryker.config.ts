import { join } from "node:path";

import { type PartialStrykerOptions, sharedConfig } from "../../stryker.shared.config.ts";

const config: PartialStrykerOptions = {
	...sharedConfig,
	tsconfigFile: "tsconfig.json",
	vitest: {
		configFile: join(import.meta.dirname, "vitest.stryker.config.ts"),
	},
};

export default config;
