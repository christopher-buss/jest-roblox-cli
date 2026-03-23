export interface TscErrorInfo {
	column: number;
	errorCode: number;
	errorMessage: string;
	filePath: string;
	line: number;
}

export type RawErrorsMap = Map<string, Array<TscErrorInfo>>;

export interface TestDefinition {
	name: string;
	ancestorNames: Array<string>;
	end: number;
	start: number;
	type: "suite" | "test";
}
