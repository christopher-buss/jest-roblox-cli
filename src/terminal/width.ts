import process from "node:process";

interface ColumnsSource {
	columns?: number;
}

/**
 * Width to wrap output at.
 * @param stream - The stream the output goes to.
 * @returns Its column count, or 80 when it reports none.
 */
export function getTerminalWidth(stream: ColumnsSource = process.stdout): number {
	return readStreamColumns(stream) ?? 80;
}

/**
 * The stream's column count, else the environment's `COLUMNS`.
 * @param options - Where to read the width from.
 * @param options.environment - Environment to read `COLUMNS` from.
 * @param options.stream - The stream the output goes to.
 * @returns The column count, or undefined when neither gives a positive one.
 */
export function readTerminalColumns({
	environment = process.env,
	stream = process.stdout,
}: {
	readonly environment?: NodeJS.ProcessEnv;
	readonly stream?: ColumnsSource;
} = {}): number | undefined {
	const parsed = Number(environment["COLUMNS"]);
	return (
		readStreamColumns(stream) ?? (Number.isFinite(parsed) && parsed > 0 ? parsed : undefined)
	);
}

function readStreamColumns(stream: ColumnsSource): number | undefined {
	return stream.columns !== undefined && stream.columns > 0 ? stream.columns : undefined;
}
