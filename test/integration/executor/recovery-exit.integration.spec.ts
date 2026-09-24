import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LOADER_URL = pathToFileURL(
	path.resolve(import.meta.dirname, "../../../loaders/luau-raw.mjs"),
);
const RECOVERY_URL = pathToFileURL(
	path.resolve(import.meta.dirname, "../../../src/backends/execution-recovery.ts"),
);
const RUNNER_URL = new URL(
	"./src/ocale-runner.ts",
	import.meta.resolve("@isentinel/roblox-runner/package.json"),
);
const OCALE_TESTING_URL = pathToFileURL(
	path.resolve(import.meta.dirname, "../../../node_modules/@bedrock-rbx/ocale/dist/testing.mjs"),
);
const CLAIM_URL = pathToFileURL(
	path.resolve(import.meta.dirname, "../../../src/luau/execution-claim.ts"),
);
const STORAGE_URL = import.meta.resolve("@bedrock-rbx/ocale/storage");
const OCALE_URL = import.meta.resolve("@bedrock-rbx/ocale");

const CHILD_SCRIPT = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
registerHooks(await import(${JSON.stringify(LOADER_URL.href)}));
const { executeWithRecoveryAsync } = await import(${JSON.stringify(RECOVERY_URL.href)});
const { OcaleRunner } = await import(${JSON.stringify(RUNNER_URL.href)});
const { createFakeHttpClient } = await import(${JSON.stringify(OCALE_TESTING_URL.href)});
const { ExecutionClaimObserver } = await import(${JSON.stringify(CLAIM_URL.href)});
const { StorageClient } = await import(${JSON.stringify(STORAGE_URL)});
const { RateLimitError } = await import(${JSON.stringify(OCALE_URL)});
const mode = process.argv[1];
const task = {
  createTime: "2026-01-01T00:00:00Z",
  path: "universes/123/places/456/versions/1/luau-execution-sessions/session-1/tasks/task-1",
  state: "PROCESSING",
  updateTime: "2026-01-01T00:00:00Z",
  user: "user-1",
};
const http = createFakeHttpClient();
if (mode === "queue") {
  http.mockResponse({ body: { code: "NOT_FOUND", message: "missing" }, status: 404 });
} else if (mode === "retry") {
  http.mockError(new RateLimitError("Rate limited", {
    details: { errors: [{ code: 0, message: "" }] },
    retryAfterSeconds: 0.1,
    statusCode: 429,
  }));
  http.mockResponse({ body: task, status: 200 });
} else {
  http.mockResponse({ body: task, status: 200 });
  http.mockResponse({ body: mode === "logs" ? { ...task, state: "FAILED", error: { code: "SCRIPT_ERROR", message: "failed" } } : task, status: 200 });
  if (mode === "normal") {
    http.mockResponse({
      body: { ...task, output: { results: ["complete"] }, state: "COMPLETE" },
      status: 200,
    });
  }
}
const transport = {
  request: async (request, config) => {
    if (((mode === "request" || mode === "claim") && request.method === "GET") ||
        ((mode === "submit" || mode === "budget") && request.method === "POST") ||
        (mode === "logs" && request.url.includes("/logs"))) {
      await delay(1_500, undefined, { signal: config.signal });
    }
    return http.request(request, config);
  },
};
const runner = new OcaleRunner(
  { apiKey: "test-key", placeId: "456", universeId: "123" },
  { httpClient: transport },
);
let attempt = 0;
const observer = new ExecutionClaimObserver({
  credentials: { apiKey: "test-key", universeId: "123" },
  storageFactory: () => new StorageClient({ apiKey: "test-key", httpClient: transport }),
});
if (mode === "recovery") {
  const originalReadStarted = Promise.withResolvers();
  const readers = [true, false].map((isOriginal) => {
    const recoveryHttp = createFakeHttpClient();
    recoveryHttp.mockResponse({ body: task, status: 200 });
    recoveryHttp.mockResponse({ body: task, status: 200 });
    recoveryHttp.mockResponse({ body: { ...task, state: "COMPLETE", output: { results: ["complete"] } }, status: 200 });
    let reads = 0;
    return new OcaleRunner(
      { apiKey: "test-key", placeId: "456", universeId: "123" },
      {
        sleep: async () => delay(2),
        httpClient: {
          request: async (request, config) => {
            if (request.method === "GET" && ++reads > 1) {
              if (isOriginal) {
                originalReadStarted.resolve();
                await delay(1_500, undefined, { signal: config.signal });
              } else {
                await originalReadStarted.promise;
              }
            }
            return recoveryHttp.request(request, config);
          },
        },
      },
    );
  });
  const result = await executeWithRecoveryAsync({
    executeAsync: ({ observationSignal }) => readers[attempt++].executeScriptAsync({
      observationSignal, pollBudget: 1, script: "return 1", timeout: 1_000,
    }),
    timeout: 1_000,
  });
  assert.equal(attempt, 2);
  assert.equal(result.outputs[0], "complete");
} else if (mode === "queue") {
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(observer.readAsync("canceled", canceled.signal));
  assert.equal((await observer.readAsync("next")).status, "missing");
  assert.equal(http.requests.length, 1);
} else if (mode === "normal") {
  const result = await runner.executeScriptAsync({ script: "return 1", timeout: 2_000 });
  assert.equal(result.outputs[0], "complete");
} else if (mode === "budget") {
  await assert.rejects(
    runner.executeScriptAsync({ script: "return 1", submitBudget: 10, timeout: 1_000 }),
    /did not accept the task/,
  );
} else {
  const result = await executeWithRecoveryAsync({
	  bootWatchMs: 10,
	  executeAsync: async ({ claim, observationSignal: signal }) => {
	    attempt += 1;
	    if (mode === "claim") {
	      await delay(50);
	      return { durationMs: 1, outputs: ["complete"] };
	    }
	    if (attempt === 1) {
	      return runner.executeScriptAsync({ observationSignal: signal, script: claim, timeout: 1_000 });
	    }
	    await delay(50);
	    return { durationMs: 1, outputs: ["complete"] };
	  },
    readClaimAsync: mode === "claim" ? observer.readAsync.bind(observer) : async () => ({ status: "missing" }),
    timeout: 1_000,
  });
  assert.equal(result.outputs[0], "complete");
  if (mode === "retry") {
    await delay(250);
    assert.equal(http.requests.length, 1, "aborted retry sent another request");
  }
}
const resolvedAt = performance.now();
process.once("beforeExit", () => {
  assert.ok(performance.now() - resolvedAt < 200, "superseded observation kept the process alive");
});`;

describe("execution recovery process lifecycle", () => {
	it("should exit after canceling a losing native recovery read", () => {
		expect.assertions(2);

		const child = spawnSync(
			process.execPath,
			["--conditions=source", "--input-type=module", "--eval", CHILD_SCRIPT, "recovery"],
			{ encoding: "utf8", timeout: 5000, windowsHide: true },
		);

		expect(child.stderr).toContain("retrying once with the same execution claim");
		expect(child.status).toBe(0);
	});

	it.for(["sleep", "request", "submit", "logs"])(
		"should exit after cancelling an OCALE %s",
		(mode) => {
			expect.assertions(2);

			const child = spawnSync(
				process.execPath,
				["--input-type=module", "--eval", CHILD_SCRIPT, mode],
				{
					encoding: "utf8",
					windowsHide: true,
				},
			);

			expect(child.status).toBe(0);
			expect(child.stderr).toContain("starting a replacement with the same execution claim");
		},
	);

	it("should keep an ordinary polling wait alive until the task completes", () => {
		expect.assertions(1);

		const child = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", CHILD_SCRIPT, "normal"],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(child.status).toBe(0);
	});

	it("should cancel a 429 retry wait before another request is sent", () => {
		expect.assertions(2);

		const child = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", CHILD_SCRIPT, "retry"],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(child.status).toBe(0);
		expect(child.stderr).toContain("starting a replacement with the same execution claim");
	});

	it.for(["budget", "claim", "queue"])("should exit after cancelling the %s observer", (mode) => {
		expect.assertions(1);

		const child = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", CHILD_SCRIPT, mode],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(child.status).toBe(0);
	});
});
