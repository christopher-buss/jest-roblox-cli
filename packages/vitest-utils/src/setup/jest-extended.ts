import * as matchers from "jest-extended";
import { expect } from "vitest";

/** Adds the jest-extended matchers to Vitest's `expect`. */
export function registerJestExtended(): void {
	expect.extend(matchers);
}

registerJestExtended();
