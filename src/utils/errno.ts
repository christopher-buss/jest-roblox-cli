export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return (
		err instanceof Error && "code" in err && typeof (err as { code: unknown }).code === "string"
	);
}
