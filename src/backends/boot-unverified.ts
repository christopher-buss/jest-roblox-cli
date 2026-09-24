/**
 * The Boot Probe could not prove the uploaded version boots, so no test task
 * was submitted. Not a Jest result: nothing ran.
 */
export class BootUnverifiedError extends Error {
	constructor({
		booted,
		budget,
		versionNumber,
	}: {
		/**
		 * What a completed probe reported; undefined when every probe was
		 * lost.
		 */
		booted: string | undefined;
		budget: number;
		versionNumber: number;
	}) {
		const reason =
			booted === undefined
				? `no boot probe completed within ${String(Math.round(budget / 1000))}s`
				: `the boot probe reported ${JSON.stringify(booted)}`;
		super(
			`Place version ${String(versionNumber)} is boot unverified: ${reason}. No tests were submitted.`,
		);
	}
}
