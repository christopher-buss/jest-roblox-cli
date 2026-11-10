/**
 * Whether a thrown value is Node's missing-file error.
 * @param err - The thrown value.
 * @returns Whether it carries the `ENOENT` code.
 */
export function isFileNotFound(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "ENOENT";
}
