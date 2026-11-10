import { describe, expect, it } from "vitest";

import { startFakeOpenCloudServerAsync } from "#test/harness/fake-open-cloud.ts";

describe("fake Open Cloud request failures", () => {
	it("should answer a rejected queue handler and keep serving requests", async () => {
		expect.assertions(3);

		const { baseUrl } = await startFakeOpenCloudServerAsync([]);
		const url = `${baseUrl}/cloud/v2/universes/123/memory-store/queues/test/items`;
		const rejected = await fetch(url, {
			body: "{}",
			method: "POST",
			signal: AbortSignal.timeout(5000),
		});

		expect(rejected.status).toBe(500);
		await expect(rejected.text()).resolves.toContain(
			"Queue add request body must carry a non-null `data` value",
		);

		const accepted = await fetch(url, {
			body: JSON.stringify({ data: "value" }),
			method: "POST",
			signal: AbortSignal.timeout(5000),
		});
		await accepted.text();

		expect(accepted.status).toBe(200);
	});

	it.for(["{", JSON.stringify({ script: 123 })])(
		"should explain invalid task input %s",
		async (body) => {
			expect.assertions(2);

			const { baseUrl } = await startFakeOpenCloudServerAsync([]);
			const response = await fetch(
				`${baseUrl}/cloud/v2/universes/123/places/456/luau-execution-session-tasks`,
				{
					body,
					method: "POST",
					signal: AbortSignal.timeout(5000),
				},
			);

			expect(response.status).toBe(400);
			await expect(response.text()).resolves.toMatch(/Invalid request body: .+/);
		},
	);
});
