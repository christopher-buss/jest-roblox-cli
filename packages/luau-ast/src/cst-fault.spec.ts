import { describe, expect, it } from "vitest";

import { createWasmRuntime, DEFECT_MARKER } from "./wasm-runtime.ts";

describe("serializer fault", () => {
	it("should return a message instead of trapping when the writer's guard fires", () => {
		expect.assertions(2);

		const runtime = createWasmRuntime();
		runtime.injectCstFault();

		const faulted = runtime.parseToCstJson("local x = 1");
		const recovered = runtime.parseToCstJson("local x = 1");

		expect(faulted).toBe(`${DEFECT_MARKER}cst writer: close without a matching open`);
		expect(recovered.startsWith("{")).toBe(true);
	});
});
