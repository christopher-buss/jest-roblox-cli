import type { ColorFunc, Styles } from "../styles.ts";

function tag(name: string): ColorFunc {
	return (text) => `<${name}>${text}</${name}>`;
}

export function createTaggedStyles(): Styles {
	return {
		diff: { expected: tag("expected"), received: tag("received") },
		dim: tag("dim"),
		duration: { fast: tag("fast"), slow: tag("slow") },
		failBadge: tag("failBadge"),
		lineNumber: tag("lineNumber"),
		location: tag("location"),
		path: { dir: tag("dir"), file: tag("file") },
		runBadge: tag("runBadge"),
		slowTestThreshold: 300,
		status: { fail: tag("fail"), pass: tag("pass"), pending: tag("pending") },
		summary: {
			failed: tag("summaryFailed"),
			passed: tag("summaryPassed"),
			pending: tag("summaryPending"),
		},
	};
}
