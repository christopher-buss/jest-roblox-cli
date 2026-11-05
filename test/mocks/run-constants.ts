import * as path from "node:path";

export const MANIFEST_VERSION = 5 as const;

export const STUB_FILENAME = "jest.config.luau";

export const COVERAGE_BUILD_MANIFEST_PATH: string = path.join(
	".jest-roblox/coverage",
	"build-manifest.json",
);
