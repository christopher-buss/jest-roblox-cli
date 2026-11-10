const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");

export interface SourceMapSegment {
	/** Zero-based column in the generated file. */
	readonly generatedColumn: number;
	/** One-based line in the generated file. */
	readonly generatedLine: number;
	/** Zero-based column in the original source. */
	readonly sourceColumn: number;
	/** One-based line in the original source. */
	readonly sourceLine: number;
}

export interface SourceMapOptions {
	readonly file: string;
	readonly segments: ReadonlyArray<SourceMapSegment>;
	readonly source: string;
	readonly sourceContent?: string;
}

export function buildSourceMap({
	file,
	segments,
	source,
	sourceContent,
}: SourceMapOptions): string {
	return JSON.stringify({
		file,
		mappings: encodeMappings(segments),
		sources: [source],
		version: 3,
		...(sourceContent === undefined ? {} : { sourcesContent: [sourceContent] }),
	});
}

function encodeVlq(value: number): string {
	let remaining = value < 0 ? (-value << 1) | 1 : value << 1;
	let encoded = "";
	do {
		let digit = remaining & 0b11111;
		remaining >>>= 5;
		if (remaining > 0) {
			digit |= 0b100000;
		}

		encoded += BASE64[digit];
	} while (remaining > 0);

	return encoded;
}

function encodeMappings(segments: ReadonlyArray<SourceMapSegment>): string {
	const lastLine = segments.reduce((highest, { generatedLine }) => {
		return Math.max(highest, generatedLine);
	}, 0);

	let previousSourceLine = 0;
	let previousSourceColumn = 0;
	const lines: Array<string> = [];
	for (let line = 1; line <= lastLine; line += 1) {
		const onLine = segments
			.filter((segment) => segment.generatedLine === line)
			.toSorted((left, right) => left.generatedColumn - right.generatedColumn);

		let previousGeneratedColumn = 0;
		const encoded: Array<string> = [];
		for (const segment of onLine) {
			encoded.push(
				encodeVlq(segment.generatedColumn - previousGeneratedColumn) +
					encodeVlq(0) +
					encodeVlq(segment.sourceLine - 1 - previousSourceLine) +
					encodeVlq(segment.sourceColumn - previousSourceColumn),
			);
			previousGeneratedColumn = segment.generatedColumn;
			previousSourceLine = segment.sourceLine - 1;
			previousSourceColumn = segment.sourceColumn;
		}

		lines.push(encoded.join(","));
	}

	return lines.join(";");
}
