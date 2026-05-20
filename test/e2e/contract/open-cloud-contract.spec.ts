import { type } from "arktype";
import buffer from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { type FakeOpenCloudTask, startFakeOpenCloudServer } from "../cli/fake-open-cloud.ts";

interface HttpResponse {
	body: unknown;
	ok: boolean;
	status: number;
}

interface HttpClient {
	request(
		method: string,
		url: string,
		options?: { body?: unknown; headers?: Record<string, string> },
	): Promise<HttpResponse>;
}

// The contract suite asserts the response shapes the OpenCloudBackend reads
// from the wire (`src/backends/open-cloud.ts:176-177, 207-225, 257-279`).
// Each assertion runs twice: once against the in-process fake, once against
// the live `apis.roblox.com` URL (gated by JEST_ROBLOX_LIVE=1 plus
// credentials). If the fake's reply shape drifts from the live wire, one
// branch will fail.

const POLL_INTERVAL_MS = 1000;
const FAILURE_TIMEOUT_MS = 60_000;
const SUCCESS_TIMEOUT_MS = 60_000;

const PLACE_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/live-place/game.rbxl");

const versionResponseSchema = type({ versionNumber: "number" });
const taskCreateResponseSchema = type({ path: "string" });
const taskStatusResponseSchema = type({
	"error?": { "message?": "string" },
	"output?": { "results?": "string[]" },
	"state": "'CANCELLED' | 'COMPLETE' | 'FAILED' | 'PROCESSING'",
});

const envelopeEntrySchema = type({
	"elapsedMs?": "number",
	"gameOutput?": "string",
	"jestOutput": "string",
});
const envelopeSchema = type({ entries: envelopeEntrySchema.array() });

interface ContractCase {
	apiKey: string;
	/**
	 * Returns the base URL plus credentials. For fake cases, this also starts
	 * a fresh fake server seeded with the supplied tasks. The fake server
	 * registers its own `onTestFinished` cleanup, so callers don't need to
	 * tear it down explicitly.
	 */
	resolve: (tasks: Array<FakeOpenCloudTask>) => Promise<{
		baseUrl: string;
		placeId: string;
		universeId: string;
	}>;
}

const liveCase = resolveLiveCase();
const fake: ContractCase = {
	apiKey: "test-api-key",
	resolve: async (tasks) => {
		const server = await startFakeOpenCloudServer(tasks);
		return { baseUrl: server.baseUrl, placeId: "456", universeId: "123" };
	},
};
const cases: Array<{ name: string; testCase: ContractCase }> =
	liveCase === undefined
		? [{ name: "fake", testCase: fake }]
		: [
				{ name: "fake", testCase: fake },
				{ name: "live", testCase: liveCase },
			];

describe.for(cases)("open Cloud contract ($name)", ({ testCase }) => {
	it("should return a numeric versionNumber from a place upload", async () => {
		expect.assertions(1);

		const { baseUrl, placeId, universeId } = await testCase.resolve([{ jestOutput: "" }]);
		const http = createHttpClient(testCase.apiKey);
		const placeData = fs.readFileSync(PLACE_FIXTURE_PATH);
		const url = `${baseUrl}/universes/v1/${universeId}/places/${placeId}/versions?versionType=Saved`;

		const response = await http.request("POST", url, {
			body: placeData,
			headers: { "Content-Type": "application/octet-stream" },
		});

		expect(versionResponseSchema(response.body)).not.toBeInstanceOf(type.errors);
	});

	it("should return a string path from task creation", async () => {
		expect.assertions(1);

		const { baseUrl, placeId, universeId } = await testCase.resolve([{ jestOutput: "" }]);
		const http = createHttpClient(testCase.apiKey);
		const url = `${baseUrl}/cloud/v2/universes/${universeId}/places/${placeId}/luau-execution-session-tasks`;

		const response = await http.request("POST", url, {
			body: { script: "return nil", timeout: "30s" },
		});

		expect(taskCreateResponseSchema(response.body)).not.toBeInstanceOf(type.errors);
	});

	it(
		"should return an envelope-shaped results[0] when the script completes",
		async () => {
			expect.assertions(4);

			const { baseUrl, placeId, universeId } = await testCase.resolve([
				// Fake-only: queue a task whose `jestOutput` field gets wrapped
				// into the envelope shape. Live ignores this — the Luau script
				// produces the envelope itself.
				{ jestOutput: JSON.stringify(buildPassingJestPayload()) },
			]);
			const http = createHttpClient(testCase.apiKey);
			const taskPath = await createTask({
				baseUrl,
				http,
				placeId,
				script: buildSuccessLuauScript(),
				universeId,
			});
			const status = await pollUntilTerminal(http, baseUrl, taskPath, SUCCESS_TIMEOUT_MS);

			expect(status.state).toBe("COMPLETE");

			const results = status.output?.results ?? [];
			const envelopeRaw = results[0];
			const parsed = parseEnvelope(envelopeRaw);

			expect(parsed).toBeDefined();
			// Assert at least one entry has a `jestOutput` string — the
			// minimum shape `parseEnvelope` and `buildProjectResult` rely on.
			expect(
				parsed?.entries.some((entry) => typeof entry.jestOutput === "string"),
			).toBeTrue();

			const second: unknown = results[1];

			expect(second === undefined || typeof second === "string").toBeTrue();
		},
		SUCCESS_TIMEOUT_MS + 5000,
	);

	it(
		"should return state=FAILED with a string error.message when the script errors",
		async () => {
			expect.assertions(2);

			const { baseUrl, placeId, universeId } = await testCase.resolve([
				{ errorMessage: "contract-failure", jestOutput: "", state: "FAILED" },
			]);
			const http = createHttpClient(testCase.apiKey);
			const taskPath = await createTask({
				baseUrl,
				http,
				placeId,
				script: 'error("contract-failure")',
				universeId,
			});
			const status = await pollUntilTerminal(http, baseUrl, taskPath, FAILURE_TIMEOUT_MS);

			expect(status.state).toBe("FAILED");
			expect(status.error?.message).toBeString();
		},
		FAILURE_TIMEOUT_MS + 5000,
	);
});

function createHttpClient(apiKey: string): HttpClient {
	return {
		async request(method, url, options) {
			const headers: Record<string, string> = {
				"x-api-key": apiKey,
				...options?.headers,
			};

			const fetchOptions: RequestInit = { headers, method };
			if (options?.body !== undefined) {
				if (options.body instanceof buffer.Buffer) {
					fetchOptions.body = options.body;
				} else {
					fetchOptions.body = JSON.stringify(options.body);
					headers["Content-Type"] = "application/json";
				}
			}

			const response = await fetch(url, fetchOptions);
			const contentType = response.headers.get("content-type") ?? "";
			const body = contentType.includes("application/json")
				? await response.json()
				: await response.text();

			return { body, ok: response.ok, status: response.status };
		},
	};
}

function resolveLiveCase(): ContractCase | undefined {
	if (process.env["JEST_ROBLOX_LIVE"] !== "1") {
		return undefined;
	}

	const apiKey = process.env["ROBLOX_OPEN_CLOUD_API_KEY"];
	const universeId = process.env["ROBLOX_UNIVERSE_ID"];
	const placeId = process.env["ROBLOX_PLACE_ID"];
	if (
		apiKey === undefined ||
		apiKey === "" ||
		universeId === undefined ||
		universeId === "" ||
		placeId === undefined ||
		placeId === ""
	) {
		return undefined;
	}

	return {
		apiKey,
		resolve: async () => {
			return {
				baseUrl: "https://apis.roblox.com",
				placeId,
				universeId,
			};
		},
	};
}

async function createTask(args: {
	baseUrl: string;
	http: HttpClient;
	placeId: string;
	script: string;
	universeId: string;
}): Promise<string> {
	const { baseUrl, http, placeId, script, universeId } = args;
	const url = `${baseUrl}/cloud/v2/universes/${universeId}/places/${placeId}/luau-execution-session-tasks`;
	const response = await http.request("POST", url, {
		body: { script, timeout: "60s" },
	});

	if (!response.ok) {
		throw new Error(`Task creation failed: status=${response.status.toString()}`);
	}

	const parsed = taskCreateResponseSchema.assert(response.body);
	return parsed.path;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function pollUntilTerminal(
	http: HttpClient,
	baseUrl: string,
	taskPath: string,
	timeoutMs: number,
): Promise<typeof taskStatusResponseSchema.infer> {
	const url = `${baseUrl}/cloud/v2/${taskPath}`;
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		const response = await http.request("GET", url);
		if (!response.ok) {
			throw new Error(`Task poll failed: status=${response.status.toString()}`);
		}

		const status = taskStatusResponseSchema.assert(response.body);
		if (status.state !== "PROCESSING") {
			return status;
		}

		await sleep(POLL_INTERVAL_MS);
	}

	throw new Error(
		`Task ${taskPath} did not reach a terminal state within ${timeoutMs.toString()}ms`,
	);
}

function parseEnvelope(raw: string | undefined): typeof envelopeSchema.infer | undefined {
	if (raw === undefined) {
		return undefined;
	}

	const decoded = JSON.parse(raw);
	const result = envelopeSchema(decoded);
	if (result instanceof type.errors) {
		return undefined;
	}

	return result;
}

function buildPassingJestPayload(): Record<string, unknown> {
	return {
		numFailedTests: 0,
		numPassedTests: 0,
		numPendingTests: 0,
		numTotalTests: 0,
		startTime: 0,
		success: true,
		testResults: [],
	};
}

function buildSuccessLuauScript(): string {
	// The live wire echoes whatever string the Luau script returns into
	// `output.results[0]`. Returning a JSON-encoded envelope here ensures the
	// parsed shape matches what `parseEnvelope` (in
	// `src/backends/open-cloud.ts`) expects.
	const envelope = {
		entries: [{ jestOutput: JSON.stringify(buildPassingJestPayload()) }],
	};

	return `return ${JSON.stringify(JSON.stringify(envelope))}`;
}
