/** Lute major version the CLI runs. */
export const SUPPORTED_LUTE_MAJOR = 1;

const VERSION_PATTERN = /^v?(\d+)\.\d+\.\d+(?:-[\w.]+)?$/;

/**
 * Check whether `lute --version` printed the supported major.
 * @param printed - Output of `lute --version`.
 * @returns Whether the version has the supported major.
 */
export function isSupportedLuteVersion(printed: string): boolean {
	const match = VERSION_PATTERN.exec(printed.slice(printed.lastIndexOf(" ") + 1));
	return match !== null && Number(match[1]) === SUPPORTED_LUTE_MAJOR;
}
