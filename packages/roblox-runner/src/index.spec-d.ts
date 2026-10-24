import { describe, expectTypeOf, it } from "vitest";

import type {
	BinaryInputUploader,
	createJsonWorkQueueWriter,
	createWorkQueueReader,
	ExecuteScriptOptions,
	OcaleRunner,
	RemoteRunner,
	RunnerCredentials,
	ScriptResult,
	TaskPoolOptions,
	WorkQueueReader,
	WorkQueueWriter,
} from "./index.ts";
import { maximumSubmitDuration, resolveCredentials, runTaskPool } from "./index.ts";

describe("package entry point types", () => {
	it("should expose the supported runner and credential contracts", () => {
		expectTypeOf<InstanceType<typeof OcaleRunner>>().toExtend<
			BinaryInputUploader & RemoteRunner
		>();
		expectTypeOf(resolveCredentials).returns.toEqualTypeOf<RunnerCredentials>();
		expectTypeOf<RemoteRunner["executeScriptAsync"]>().toEqualTypeOf<
			(options: ExecuteScriptOptions) => Promise<ScriptResult>
		>();
		expectTypeOf(runTaskPool).toEqualTypeOf<(options: TaskPoolOptions) => Promise<void>>();
		expectTypeOf(maximumSubmitDuration({ submitBudget: 1 })).toEqualTypeOf<number>();
		expectTypeOf(maximumSubmitDuration({})).toEqualTypeOf<number | undefined>();
	});

	it("should preserve queue payload types across entry points", () => {
		expectTypeOf<ReturnType<typeof createWorkQueueReader<string>>>().toEqualTypeOf<
			WorkQueueReader<string>
		>();
		expectTypeOf<ReturnType<typeof createJsonWorkQueueWriter<{ id: string }>>>().toEqualTypeOf<
			WorkQueueWriter<{ id: string }>
		>();
	});
});
