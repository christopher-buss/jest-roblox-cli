import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import type { TimingCollector } from "../timing/orchestration-collector.ts";
import type { TypecheckPassOutcome } from "../typecheck/group-by-tsconfig.ts";
import type { WorkspaceProjectResult } from "./coverage-attach.ts";
import { attachTypecheck } from "./typecheck-pass.ts";

describe(attachTypecheck, () => {
	it("should attach the result and record a positive typecheck span", () => {
		expect.assertions(2);

		const result = fromPartial<TypecheckPassOutcome["result"]>({ success: true });
		const results = fromPartial<Array<WorkspaceProjectResult>>([{}]);
		const record = vi.fn<TimingCollector["record"]>();

		expect(
			attachTypecheck(results, { elapsedMs: 12, result }, fromPartial({ record })),
		).toStrictEqual({ results, typecheckResult: result });
		expect(record).toHaveBeenCalledExactlyOnceWith("runTypecheck", 12);
	});

	it("should leave a zero-length typecheck span out of timing", () => {
		expect.assertions(2);

		const record = vi.fn<TimingCollector["record"]>();

		expect(attachTypecheck([], { elapsedMs: 0 }, fromPartial({ record }))).toStrictEqual({
			results: [],
			typecheckResult: undefined,
		});
		expect(record).not.toHaveBeenCalled();
	});
});
