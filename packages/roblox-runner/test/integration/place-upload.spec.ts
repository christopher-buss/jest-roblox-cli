import { OcaleRunner } from "@isentinel/roblox-runner";

import buffer from "node:buffer";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { assert, describe, expect, it, onTestFinished } from "vitest";

async function makeUploadServerAsync() {
	let requests = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		if (requests === 1) {
			response.destroy();
			return;
		}

		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ versionNumber: 17 }));
	});
	onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error === undefined) {
					resolve();
				} else {
					reject(error);
				}
			});
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address !== null && typeof address === "object");
	return { baseUrl: `http://127.0.0.1:${String(address.port)}`, count: () => requests };
}

function makePlaceFile(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-runner-"));
	onTestFinished(() => {
		fs.rmSync(directory, { force: true, recursive: true });
	});
	const file = path.join(directory, "test.rbxl");
	fs.writeFileSync(
		file,
		buffer.Buffer.from([
			0x3c, 0x72, 0x6f, 0x62, 0x6c, 0x6f, 0x78, 0x21, 0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a,
		]),
	);
	return file;
}

describe("native place upload adapters", () => {
	it("should read a binary place and retry a reset native fetch connection", async () => {
		expect.assertions(2);

		const server = await makeUploadServerAsync();
		const placeFilePath = makePlaceFile();
		const runner = new OcaleRunner(
			{ apiKey: "test-key", placeId: "456", universeId: "123" },
			{ baseUrl: server.baseUrl, sleep: async () => {} },
		);
		const result = await runner.uploadPlaceAsync({ placeFilePath });

		expect(result.versionNumber).toBe(17);
		expect(server.count()).toBe(2);
	});
});
