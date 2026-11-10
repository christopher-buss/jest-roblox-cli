import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { prepareWorkspaceDispatch } from "./dispatch.ts";

const ENTRY = {
	elapsedMs: 5,
	numFailedTests: 0,
	numPassedTests: 1,
	numPendingTests: 0,
	pkg: "pkg-a",
	project: "pkg-a",
	success: true,
};

describe(prepareWorkspaceDispatch, () => {
	it("should pass the run's parallelism and bail through", () => {
		expect.assertions(1);

		const spec = prepareWorkspaceDispatch({ bail: true, parallel: "auto", vmParallel: 2 });

		expect(spec).toStrictEqual({
			bail: true,
			parallel: "auto",
			vmParallel: 2,
			workspace: { onPackageResult: undefined },
		});
	});

	it("should not bail unless asked", () => {
		expect.assertions(1);

		const spec = prepareWorkspaceDispatch({});

		expect(spec.bail).toBeFalse();
	});

	it("should pass each streamed package to the consumer once", () => {
		expect.assertions(1);

		const onStreamingResult = vi.fn<(entry: typeof ENTRY) => void>();
		const spec = prepareWorkspaceDispatch({ onStreamingResult, parallel: 2 });
		const { onPackageResult } = fromAny<
			{ onPackageResult: (entry: typeof ENTRY) => void },
			unknown
		>(spec.workspace);
		onPackageResult(ENTRY);
		onPackageResult(ENTRY);

		expect(onStreamingResult).toHaveBeenCalledOnce();
	});
});
