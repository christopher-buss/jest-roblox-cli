import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import {
	buildMappedResult,
	createPendingCoverage,
	fileStatementsFor,
	pendingListFor,
	pushPendingBranch,
} from "./mapper-pending.ts";
import type { PendingBranch } from "./mapper-types.ts";

const span = { end: { column: 4, line: 2 }, start: { column: 0, line: 1 } };

describe(buildMappedResult, () => {
	it("should report a file that holds only functions or only branches", () => {
		expect.assertions(1);

		const pending = createPendingCoverage();
		pendingListFor(pending.functions, "a.ts").push({ name: "f", hitCount: 1, loc: span });
		pendingListFor(pending.branches, "b.ts").push({
			armHitCounts: [1],
			loc: span,
			locations: [span],
			type: "if",
		});

		expect(Object.keys(buildMappedResult(pending).files)).toStrictEqual(["a.ts", "b.ts"]);
	});

	it("should number statements across lines in insertion order", () => {
		expect.assertions(1);

		const pending = createPendingCoverage();
		const statements = fileStatementsFor(pending.statements, "a.ts");
		pendingListFor(statements, 3).push({ ...span, hitCount: 2 });
		pendingListFor(fileStatementsFor(pending.statements, "a.ts"), 1).push({
			...span,
			hitCount: 5,
		});

		expect(buildMappedResult(pending).files["a.ts"]!.s).toStrictEqual({ "0": 2, "1": 5 });
	});
});

describe(pushPendingBranch, () => {
	it("should zero-fill arms the raw data has no count for", () => {
		expect.assertions(2);

		const fileBranches: Array<PendingBranch> = [];
		const later = { end: { column: 9, line: 6 }, start: { column: 0, line: 5 } };
		pushPendingBranch({
			armHitCounts: [3],
			entry: fromAny({ locations: [span, later], type: "if" }),
			fileBranches,
			locations: [span, later],
		});

		expect(fileBranches[0]!.armHitCounts).toStrictEqual([3, 0]);
		expect(fileBranches[0]!.loc).toStrictEqual({ end: later.end, start: span.start });
	});
});
