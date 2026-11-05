import { describe, expect, it } from "vitest";

import CODE_BUNDLE_REBUILD_SOURCE from "../../luau/code-bundle-rebuild.luau";
import { prepareTaskScript } from "./task-script.ts";

describe(prepareTaskScript, () => {
	it("should bind the claim after the directives and rebuild before the body", () => {
		expect.assertions(1);

		const compose = prepareTaskScript({ script: "--!strict\nlocal value = 1\nreturn value" });

		expect(compose("CLAIM\n")).toBe(
			`--!strict\nCLAIM\n${CODE_BUNDLE_REBUILD_SOURCE}\nlocal value = 1\nreturn value`,
		);
	});
});
