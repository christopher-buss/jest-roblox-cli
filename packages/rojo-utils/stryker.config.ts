import { fileURLToPath } from "node:url";

import { type PartialStrykerOptions, sharedConfig } from "../../stryker.shared.config.ts";

const config: PartialStrykerOptions = {
	...sharedConfig,
	tsconfigFile: "tsconfig.json",
	vitest: { configFile: fileURLToPath(new URL("./vitest.stryker.config.ts", import.meta.url)) },
};

export default config;
