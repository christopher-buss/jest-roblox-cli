import { describe, expectTypeOf, it } from "vitest";

import type { CliDependencies } from "./cli.ts";
import { main, runAsync } from "./cli.ts";

describe("cli entry point types", () => {
	it("should resolve an invocation to its exit code", () => {
		expectTypeOf(runAsync).parameter(0).toEqualTypeOf<Array<string>>();
		expectTypeOf(runAsync).parameter(1).toEqualTypeOf<CliDependencies | undefined>();
		expectTypeOf(runAsync).returns.resolves.toBeNumber();
	});

	it("should run on process.argv and resolve to nothing", () => {
		expectTypeOf(main).parameter(0).toEqualTypeOf<CliDependencies | undefined>();
		expectTypeOf(main).returns.resolves.toBeVoid();
	});

	it("should make every dependency optional", () => {
		// oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty dependency object is the case under test
		expectTypeOf<Record<never, never>>().toExtend<CliDependencies>();
	});
});
