import type { Styles } from "#src/terminal/palette.ts";

export function createPlainStyles(): Styles {
	return {
		bold: plain,
		diff: { expected: plain, received: plain },
		dim: plain,
		duration: { fast: plain, slow: plain },
		failBadge: plain,
		lineNumber: plain,
		location: plain,
		path: { dir: plain, file: plain },
		projectLabel: plain,
		runBadge: plain,
		slowTestThreshold: 300,
		status: { fail: plain, pass: plain, pending: plain },
		summary: { failed: plain, passed: plain, pending: plain },
		timeoutBadge: plain,
	};
}

function plain(text: string): string {
	return text;
}
