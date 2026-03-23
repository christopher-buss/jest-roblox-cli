export interface StackFrame {
	column?: number;
	dataModelPath: string;
	line: number;
}

export interface ParsedStack {
	frames: Array<StackFrame>;
	message: string;
}
