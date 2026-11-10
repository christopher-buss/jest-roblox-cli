import { describe, expect, it } from "vitest";

import {
	encodeNilRelayFrame,
	NIL_RELAY_WAIT_SECONDS,
	NIL_RETURN_PLUGIN_WAIT_MS,
	RUNNING_WAIT_SECONDS,
	STUDIO_FRAME,
} from "./studio.ts";

describe(encodeNilRelayFrame, () => {
	it("should name the run it relays", () => {
		expect.assertions(1);

		expect(JSON.parse(encodeNilRelayFrame("request-1"))).toStrictEqual({
			requestId: "request-1",
			type: STUDIO_FRAME.nilRelay,
		});
	});
});

describe("nil-return wait ordering", () => {
	it("should give a takeover time between the plugin's two waits", () => {
		expect.assertions(2);

		expect(NIL_RETURN_PLUGIN_WAIT_MS).toBeGreaterThan(RUNNING_WAIT_SECONDS * 1000);
		expect(NIL_RETURN_PLUGIN_WAIT_MS).toBeLessThan(NIL_RELAY_WAIT_SECONDS * 1000);
	});
});
