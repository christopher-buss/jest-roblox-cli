/** One `[string "..."]:line` frame of a Luau stack trace. */
export interface StackFrame {
	/** The frame's column, when the trace has one. */
	column?: number | undefined;
	/** The dotted DataModel path of the script. */
	dataModelPath: string;
	/** The frame's Luau line. */
	line: number;
}

/** A failure message split into its text and its stack frames. */
export interface ParsedStack {
	/** The frames, in trace order. */
	frames: Array<StackFrame>;
	/** The text before the first frame. */
	message: string;
}
