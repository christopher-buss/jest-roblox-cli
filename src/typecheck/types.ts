export interface TypeTestDiagnostic {
	code: string;
	column: number;
	filePath: string;
	line: number;
	message: string;
}

export type RawErrorsMap = Map<string, Array<TypeTestDiagnostic>>;

export interface RawTestDefinition {
	name: string;
	end: number;
	start: number;
	type: "suite" | "test";
}

export interface TestDefinition extends RawTestDefinition {
	ancestorNames: Array<string>;
}

export interface CollectedFile {
	definitions: Array<TestDefinition>;
	problems: Array<Pick<TypeTestDiagnostic, "code" | "message">>;
}
