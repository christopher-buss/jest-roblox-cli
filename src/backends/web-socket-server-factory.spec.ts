import { once } from "node:events";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { nodeWebSocketServerFactory } from "./web-socket-server-factory.ts";

describe(nodeWebSocketServerFactory, () => {
	it("should open a real server on the loopback address", async () => {
		expect.assertions(1);

		const server = nodeWebSocketServerFactory({ host: "127.0.0.1", port: 0 });
		onTestFinished(() => {
			server.close();
		});

		await once(server, "listening");
		const address = server.address();

		assert(address !== null && typeof address === "object", "expected a bound address");

		expect(address.port).toBeGreaterThan(0);
	});
});
