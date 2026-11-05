export function summarizeClaims(claims: ReadonlyArray<unknown>): {
	attemptCount: number;
	claimCount: number;
} {
	const distinct = new Set(claims);
	return { attemptCount: claims.length, claimCount: distinct.size };
}
