import { vol } from "memfs";

/** Far enough back that no test clock lands on it. */
const DEFAULT_AGE_SECONDS = 60;

/**
 * Back-date a file on the memfs volume.
 *
 * `openInputDigestCache` records a digest only for a file whose mtime already
 * predates the run that read it, so a file written during a test is never
 * remembered and every spec wanting a warm digest cache has to age its inputs
 * first. `ageSeconds` is the knob for the case where two states of one file
 * must be told apart by timestamp alone.
 */
export function ageFile(filePath: string, ageSeconds: number): void {
	const aged = new Date(Date.now() - ageSeconds * 1000);
	vol.utimesSync(filePath, aged, aged);
}

/** Write a file and back-date it by {@link DEFAULT_AGE_SECONDS}. */
export function writeAgedFile(filePath: string, contents: string): void {
	vol.writeFileSync(filePath, contents);
	ageFile(filePath, DEFAULT_AGE_SECONDS);
}
