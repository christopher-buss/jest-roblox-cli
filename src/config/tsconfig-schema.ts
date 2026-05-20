import { type, type Type } from "arktype";

export interface TsconfigCompilerOptions {
	outDir?: string;
	rootDir?: null | string;
	rootDirs?: Array<string>;
}

export interface TsconfigShape {
	compilerOptions?: TsconfigCompilerOptions;
}

/**
 * Arktype schema for the subset of `tsconfig.json` the executor cares about.
 * Validating callers (production + tests) brand the parsed JSON as
 * `TsconfigShape` via `.as<...>()` — no manual cast or `JSONValue` erasure
 * needed.
 */
export const tsconfigShapeSchema: Type<TsconfigShape> = type({
	"compilerOptions?": {
		"outDir?": "string",
		"rootDir?": "string | null",
		"rootDirs?": "string[]",
	},
}).as<TsconfigShape>();
