const DRIVE_LETTER_START = /^[A-Za-z]:\//;

export function posixPath(input: string): string {
	return input
		.replaceAll("\\", "/")
		.replace(DRIVE_LETTER_START, (driveLetter) => driveLetter.toUpperCase());
}
