const DRIVE_LETTER_START_REGEX = /^[A-Za-z]:\//;

export function normalizeWindowsPath(input = ""): string {
	if (!input) {
		return input;
	}

	return input
		.replace(/\\/g, "/")
		.replace(DRIVE_LETTER_START_REGEX, (driveLetterMatch) => driveLetterMatch.toUpperCase());
}
