/** One type error a checker reported. */
export interface TypeTestDiagnostic {
	/** The checker's error code. */
	code: string;
	/** The 1-indexed column, or 0 for a file-level problem. */
	column: number;
	/** The file the error is in. */
	filePath: string;
	/** The 1-indexed line, or 0 for a file-level problem. */
	line: number;
	/** The error text. */
	message: string;
}

/** Diagnostics grouped by file path. */
export type RawErrorsMap = Map<string, Array<TypeTestDiagnostic>>;

/** A `describe` or `it` call found in a type-test file. */
export interface RawTestDefinition {
	/** The title the call declares. */
	name: string;
	/** Source offset where the call ends. */
	end: number;
	/** Source offset where the call starts. */
	start: number;
	/** Whether the call declares a suite or a test. */
	type: "suite" | "test";
}

/** A test definition with the names of its enclosing suites. */
export interface TestDefinition extends RawTestDefinition {
	/** Enclosing suite names, outermost first. */
	ancestorNames: Array<string>;
}

/** What a checker learned from reading one type-test file. */
export interface CollectedFile {
	/** The file's suites and tests, in source order. */
	definitions: Array<TestDefinition>;
	/** Source offset of each `line:column` position. */
	locations: Map<string, number>;
	/** Adjusts the checker's raw diagnostics for this file. */
	resolve: (diagnostics: Array<TypeTestDiagnostic>) => Array<TypeTestDiagnostic>;
}
