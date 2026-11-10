const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * 1024;

/**
 * Formats a byte count with a `B`, `KB` or `MB` unit.
 * @param bytes - Size in bytes.
 * @returns The size with its `B`, `KB` or `MB` unit.
 */
export function formatBytes(bytes: number): string {
	if (bytes < BYTES_PER_KILOBYTE) {
		return `${bytes.toFixed(0)} B`;
	}

	if (bytes < BYTES_PER_MEGABYTE) {
		return `${(bytes / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
	}

	return `${(bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`;
}
