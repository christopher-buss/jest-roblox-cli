/**
 * Message text for an unknown thrown value: `Error.message` when it is an
 * `Error`, its string form otherwise. Lets a `catch` that only formats a
 * warning line read the message without narrowing at every site.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
