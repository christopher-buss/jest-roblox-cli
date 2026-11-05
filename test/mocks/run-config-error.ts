import { expect } from "vitest";

export function configErrorLike(
	message?: RegExp | string,
	...hint: [hint?: string | undefined]
): ReturnType<typeof expect.objectContaining> {
	return expect.objectContaining({
		constructor: expect.objectContaining({ name: "ConfigError" }),
		...(hint.length > 0 ? { hint: hint[0] } : {}),
		message: messageMatcher(message),
	});
}

function messageMatcher(message: RegExp | string | undefined): unknown {
	if (message === undefined) {
		return expect.any(String);
	}

	return typeof message === "string" ? message : expect.stringMatching(message);
}
