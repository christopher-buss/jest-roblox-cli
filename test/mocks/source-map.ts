const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");

/** One generated position and the original position it came from. */
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
	/** The generated file the map belongs to. */
	readonly file: string;
	/** The positions the map resolves, in any order. */
	readonly segments: ReadonlyArray<SourceMapSegment>;
	/** The original source path, as the map records it. */
	readonly source: string;
	/** The original text, when the map should embed it. */
	readonly sourceContent?: string;
}

/**
 * A v3 source map over one source, built from explicit positions.
 *
 * Written out rather than fixed as a literal so a spec states the mapping it
 * needs in line and column numbers, which is what its assertions are about —
 * a hand-encoded `mappings` string states the same thing in a form no reader
 * can check against the test's expectations.
 *
 * @param options - The generated file, its source, and the positions to map.
 */
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

/** Base64 VLQ, as the source map spec defines it: sign in the low bit. */
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

/**
 * The `mappings` field: `;` per generated line, `,` per segment, every field
 * but the generated column relative to the previous segment anywhere in the
 * map.
 *
 * @param segments - The positions to encode.
 */
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
