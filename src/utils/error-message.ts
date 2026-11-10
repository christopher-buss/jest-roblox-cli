/**
 * Message text for an unknown thrown value.
 * @param err - The thrown value.
 * @returns The message text.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
