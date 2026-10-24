import { describe, expect, it } from "vitest";

import * as runner from "./index.ts";

describe("package interface", () => {
	it("should retain the supported runtime exports", () => {
		expect.assertions(1);

		expect(Object.keys(runner).sort()).toStrictEqual(
			[
				"ExecutionTimeoutError",
				"OcaleRunner",
				"PLACE_CONTENT_ID_NAME",
				"PLACE_CONTENT_ID_SERVICE",
				"ProgressMap",
				"SortedMapInbox",
				"TaskQuotaError",
				"TaskStallError",
				"TaskSubmitError",
				"createJsonWorkQueueWriter",
				"createMemoryStoreJanitor",
				"createWorkQueueHost",
				"createWorkQueueReader",
				"createWorkQueueWriter",
				"flushMemoryStoreAsync",
				"maximumSubmitDuration",
				"placeIdentityGuardSource",
				"publishMessageAsync",
				"readRefusedPlaceVersion",
				"resolveCredentials",
				"runTaskPool",
			].sort(),
		);
	});
});
