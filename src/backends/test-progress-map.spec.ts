import { describe, expect, it } from "vitest";

import { resolveTestProgressMapId } from "./test-progress-map.ts";

describe(resolveTestProgressMapId, () => {
	it("should mint a map for an Open Cloud run", () => {
		expect.assertions(1);

		expect(resolveTestProgressMapId({ kind: "open-cloud" })).toMatch(
			/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
		);
	});

	// Per run, not per process: two runs sharing an id would read each other's
	// heartbeats back, and the banner would name a test from the wrong run.
	it("should mint a fresh map for every run", () => {
		expect.assertions(1);

		const first = resolveTestProgressMapId({ kind: "open-cloud" });

		expect(resolveTestProgressMapId({ kind: "open-cloud" })).not.toBe(first);
	});

	// A wedge is the one failure Roblox describes with nothing at all, and only
	// Open Cloud can produce it. Studio reports its own, so a heartbeat there
	// would spend MemoryStore quota to duplicate an answer the run already has.
	it.for(["studio", "studio-cli"] as const)("should keep no map for %s", (kind) => {
		expect.assertions(1);

		expect(resolveTestProgressMapId({ kind })).toBeUndefined();
	});

	// `--typecheckOnly` resolves no backend at all: nothing is dispatched, so
	// there is no task to heartbeat out of.
	it("should keep no map when the run resolved no backend", () => {
		expect.assertions(1);

		expect(resolveTestProgressMapId(undefined)).toBeUndefined();
	});
});
