import * as matchers from "jest-extended";
import { expect } from "vitest";

/** Adds the jest-extended matchers that Vitest's `expect` does not have. */
export function registerJestExtended(): void {
	const builtIn = expect(undefined);
	const added = { ...matchers };
	for (const name of Object.keys(added)) {
		if (name in builtIn) {
			delete added[name];
		}
	}

	expect.extend(added);
}

registerJestExtended();
