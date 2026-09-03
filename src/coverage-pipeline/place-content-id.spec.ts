import { describe, expect, it } from "vitest";

import type { PlaceCoveringSet } from "./place-content-id.ts";
import { computePlaceContentId } from "./place-content-id.ts";

/** The id every case below has to arrive at. */
const DIGEST = "22edc4ff38c8bb8dea2e58278b6a2e3c508f17ecc641fe0eb48be400cbace3a5";

function covering(): PlaceCoveringSet {
	return {
		files: {
			"out/a.luau": { sourceHash: "aa" },
			"out/b.luau": { sourceHash: "bb" },
		},
		nonInstrumentedFiles: { "out/a.spec.luau": { sourceHash: "cc" } },
	};
}

describe(computePlaceContentId, () => {
	it("should digest the covering set to a stable literal", () => {
		expect.assertions(1);

		// Pinned to the literal: the id is stamped into a place and compared
		// against a host that recomputed it, so a silent change to these bytes
		// refuses every place built before the change.
		expect(computePlaceContentId(covering())).toBe(DIGEST);
	});

	it("should not depend on the order the records were recorded in", () => {
		expect.assertions(1);

		// The maps' key order is the order the instrumenter walked in, which two
		// builds of one tree need not agree on. Written out of order on purpose
		// — sorting these keys is deleting the case.
		// eslint-disable-next-line perfectionist/sort-objects -- see above
		const files = { "out/b.luau": { sourceHash: "bb" }, "out/a.luau": { sourceHash: "aa" } };

		expect(computePlaceContentId({ ...covering(), files })).toBe(DIGEST);
	});

	it("should move when only an unprobed file moves", () => {
		expect.assertions(1);

		// The specs the place carries decide every verdict, and no probed file
		// changes when one is edited — so a digest over the probed half alone
		// would score this build's mutants against another build's tests.
		const set = covering();
		set.nonInstrumentedFiles["out/a.spec.luau"] = { sourceHash: "edited" };

		expect(computePlaceContentId(set)).not.toBe(DIGEST);
	});
});
