import * as path from "node:path";

export const MANIFEST_VERSION = 5 as const;

export const BUILD_MANIFEST_VERSION = 2 as const;

export const INSTRUMENTER_VERSION = 6;

export const CODE_SPLIT_PASS_VERSION = 1;

export const COVERAGE_PLACE_FILE: string = path.join(".jest-roblox/place", "game.rbxl");
