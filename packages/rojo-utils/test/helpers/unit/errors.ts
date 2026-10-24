import { assert } from "vitest";

export function captureError(action: () => unknown): Error {
	try {
		action();
	} catch (err) {
		assert(err instanceof Error);
		return err;
	}

	throw new Error("Expected operation to throw");
}
