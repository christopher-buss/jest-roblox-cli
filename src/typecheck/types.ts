export interface TypeTestDiagnostic {
	code: string;
	column: number;
	filePath: string;
	line: number;
	message: string;
}

export type RawErrorsMap = Map<string, Array<TypeTestDiagnostic>>;

export interface TestDefinition {
	name: string;
	ancestorNames: Array<string>;
	end: number;
	start: number;
	type: "suite" | "test";
}
