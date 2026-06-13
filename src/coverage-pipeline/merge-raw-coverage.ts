import type { RawCoverageData, RawFileCoverage } from "./types.ts";

/**
 * Additively merge two raw coverage datasets. Overlapping files have their
 * hit counts summed (matching istanbul-lib-coverage's semantics).
 */
export function mergeRawCoverage(
	target: RawCoverageData | undefined,
	source: RawCoverageData | undefined,
): RawCoverageData | undefined {
	if (target === undefined) {
		return source;
	}

	if (source === undefined) {
		return target;
	}

	const result = { ...target } satisfies RawCoverageData;
	for (const [filePath, fileCoverage] of Object.entries(source)) {
		const existing = result[filePath];
		result[filePath] =
			existing === undefined
				? { ...fileCoverage }
				: mergeFileCoverage(existing, fileCoverage);
	}

	return result;
}

function sumScalars(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
	const result = { ...a };
	for (const [key, value] of Object.entries(b)) {
		result[key] = (result[key] ?? 0) + value;
	}

	return result;
}

function sumBranches(
	a: Record<string, Array<number>>,
	b: Record<string, Array<number>>,
): Record<string, Array<number>> {
	const result: Record<string, Array<number>> = { ...a };
	for (const [key, bArms] of Object.entries(b)) {
		const aArms = result[key];
		if (aArms === undefined) {
			result[key] = [...bArms];
			continue;
		}

		const length = Math.max(aArms.length, bArms.length);
		result[key] = Array.from(
			{ length },
			(_, index) => (aArms[index] ?? 0) + (bArms[index] ?? 0),
		);
	}

	return result;
}

function mergeFileCoverage(a: RawFileCoverage, b: RawFileCoverage): RawFileCoverage {
	const merged: RawFileCoverage = {
		s: sumScalars(a.s, b.s),
	};

	if (a.f !== undefined || b.f !== undefined) {
		merged.f = sumScalars(a.f ?? {}, b.f ?? {});
	}

	if (a.b !== undefined || b.b !== undefined) {
		merged.b = sumBranches(a.b ?? {}, b.b ?? {});
	}

	return merged;
}
