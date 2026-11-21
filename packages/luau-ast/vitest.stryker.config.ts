import { mergeConfig } from "vitest/config";

import { sharedConfig } from "../../vitest.shared.ts";
import { strykerConfig } from "../../vitest.stryker.shared.ts";

export default mergeConfig(sharedConfig, strykerConfig);
