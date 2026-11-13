import { ApiError, NetworkError, PermissionError, RateLimitError } from "@bedrock-rbx/ocale";
import { TaskQuotaError, TaskStallError } from "@isentinel/roblox-runner";

import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import type { MockInstance } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { printError } from "./cli-errors.ts";
import { ConfigError } from "./config/errors.ts";
import { LuauScriptError } from "./jest-output/luau-script-error.ts";
import type { RunnerErrorCode } from "./protocol/runner-error.ts";
import { MissingGapRecordError } from "./utils/infrastructure-failure.ts";

type MockedWrite = MockInstance<typeof process.stderr.write>;

type MockedConsole = MockInstance<typeof console.error>;

interface OutputSpies {
	consoleError: MockedConsole;
	stderr: MockedWrite;
}

function setupOutputSpies(): OutputSpies {
	return {
		consoleError: vi.spyOn(console, "error").mockImplementation(() => {}),
		stderr: vi.spyOn(process.stderr, "write").mockReturnValue(true),
	};
}

function renderedStderr(spies: OutputSpies): string {
	return stripVTControlCharacters(
		spies.stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
	);
}

describe(printError, () => {
	it("should print the hint inside a ConfigError banner", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		printError(new ConfigError("bad value", "try this instead"));

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("bad value"));
		expect(renderedStderr(spies)).toContain("\n  Hint: try this instead\n");
	});

	it("should return 2 and print banner for ConfigError without hint", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		printError(new ConfigError("missing field"));

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("missing field"));
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should return 2 and print hint for LuauScriptError matching a known pattern", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		printError(
			codedError("Failed to find Jest instance in ReplicatedStorage", "jest-not-found"),
		);

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Hint:"));
	});

	it("should omit Hint section for LuauScriptError with no matching pattern", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(new LuauScriptError("Some unrelated runtime error"));

		expect(renderedStderr(spies)).toMatchInlineSnapshot(`
			"
			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Luau Error ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

			Some unrelated runtime error

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

			"
		`);
	});

	it("should lead the banner with captured banner output when the message is just an exit code", () => {
		// When Jest exits via process.exit(N), the message "Exited
		// with code: N" is only a transport; the real error message Jest
		// printed to stdout lives in `bannerOutput` (the InterceptWriteable
		// capture, distinct from the LogService-sourced `gameOutput` dump).
		// Lead the banner with that.
		expect.assertions(4);

		const spies = setupOutputSpies();

		const error = new LuauScriptError("Exited with code: 1");
		error.bannerOutput = JSON.stringify([
			{ message: "No tests found, exiting with code 1", messageType: 0, timestamp: 0 },
			{
				message: "Run with `--passWithNoTests` to exit with code 0",
				messageType: 0,
				timestamp: 0,
			},
		]);
		printError(error);

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Test Run Failed"));
		expect(renderedStderr(spies)).toContain(
			"\n  No tests found, exiting with code 1\n  Run with `--passWithNoTests` to exit with code 0\n\n  Exited with code: 1\n",
		);
		// Game output is the primary content now, not a sub-section.
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Game output:"));
		// "Luau Error" title is reserved for actual Luau crashes.
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
	});

	it("should recognize a multi-digit exit code only when it is the complete message", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();

		const error = new LuauScriptError("Exited with code: 12");
		error.bannerOutput = JSON.stringify([
			{ message: "captured failure", messageType: 0, timestamp: 0 },
		]);
		printError(error);

		expect(renderedStderr(spies)).toContain("captured failure\n\n  Exited with code: 12");
		expect(renderedStderr(spies)).not.toContain("Game output:");
	});

	it.for(["prefix Exited with code: 1", "Exited with code: 1 trailing"] as const)(
		"should keep captured output as context for non-exact exit message %j",
		async (message) => {
			expect.assertions(1);

			const spies = setupOutputSpies();

			const error = new LuauScriptError(message);
			error.bannerOutput = JSON.stringify([
				{ message: "captured context", messageType: 0, timestamp: 0 },
			]);
			printError(error);

			expect(renderedStderr(spies)).toContain("Game output:\n  captured context");
		},
	);

	it("should print banner output context for LuauScriptError with parseable bannerOutput", () => {
		// Non-exit-code LuauScriptError (e.g. config / Jest-resolution failure)
		// keeps the original layout: message as primary, bannerOutput as hint.
		expect.assertions(2);

		const spies = setupOutputSpies();

		const error = new LuauScriptError("Failed to find Jest instance in ReplicatedStorage");
		error.bannerOutput = JSON.stringify([
			{ message: "diagnostic output", messageType: 0, timestamp: 0 },
		]);
		printError(error);

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Luau Error"));
		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Game output:"));
	});

	it("should omit Game output section when bannerOutput parses to empty array", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();

		const error = new LuauScriptError("Exited with code: 1");
		error.bannerOutput = "[]";
		printError(error);

		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Game output:"));
	});

	it("should omit Game output section when gameOutput is undefined", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(new LuauScriptError("Exited with code: 1"));

		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Game output:"));
	});

	it("should return 2 and print message for generic Error", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(new Error("something broke"));

		expect(spies.consoleError).toHaveBeenCalledWith("Error: something broke");
	});

	it("should return 2 for unknown error type", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError("string-error");

		expect(spies.consoleError).toHaveBeenCalledWith("An unknown error occurred");
	});

	it("should return 3 and report a stalled task as a Roblox infrastructure failure with its evidence", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const stalled = new TaskStallError({
			error: new Error("Execution timed out"),
			evidence: {
				createTime: "2026-09-23T10:00:00.000Z",
				kind: "task-stall",
				observedStates: ["QUEUED", "PROCESSING"],
				placeVersion: 42,
				task: "universes/1/places/2/versions/42/luau-execution-sessions/s/tasks/t",
				timeoutSeconds: 300,
				updateTime: "2026-09-23T10:05:00.000Z",
			},
			readResultAsync: async () => ({ durationMs: 0, outputs: [] }),
		});
		printError(stalled);

		expect(renderedStderr(spies)).toContain("Roblox Infrastructure Error");
		expect(renderedStderr(spies)).toContain(
			[
				"  Evidence:",
				"    kind: task-stall",
				"    task: universes/1/places/2/versions/42/luau-execution-sessions/s/tasks/t",
				"    placeVersion: 42",
				"    timeoutSeconds: 300",
				"    createTime: 2026-09-23T10:00:00.000Z",
				"    updateTime: 2026-09-23T10:05:00.000Z",
				"    observedStates: QUEUED, PROCESSING",
			].join("\n"),
		);
	});

	it("should render a missing gap record without evidence", () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		printError(new MissingGapRecordError("The run has no gap record"));

		expect(renderedStderr(spies)).toContain("Missing Gap Record");
		expect(renderedStderr(spies)).toContain("The run has no gap record");
		expect(renderedStderr(spies)).not.toContain("Evidence:");
	});

	it("should omit evidence fields Roblox did not report", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(
			new TaskStallError({
				error: new Error("Execution timed out"),
				evidence: {
					createTime: undefined,
					kind: "task-stall",
					observedStates: ["PROCESSING"],
					placeVersion: undefined,
					task: "universes/1/places/2/luau-execution-sessions/s/tasks/t",
					timeoutSeconds: 300,
					updateTime: undefined,
				},
				readResultAsync: async () => ({ durationMs: 0, outputs: [] }),
			}),
		);

		expect(renderedStderr(spies)).toContain(
			[
				"    task: universes/1/places/2/luau-execution-sessions/s/tasks/t",
				"    timeoutSeconds: 300",
				"    observedStates: PROCESSING",
			].join("\n"),
		);
	});

	it("should report a quota-refused create with its evidence and headers", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		printError(
			new TaskQuotaError({
				cause: new RateLimitError("Rate limited", {
					retryAfterSeconds: 1856,
					statusCode: 429,
				}),
				evidence: {
					code: "RESOURCE_EXHAUSTED",
					headers: { "retry-after": "1856" },
					kind: "create-quota",
					placeVersion: 42,
					retryAfterSeconds: 1856,
					timeoutSeconds: 300,
					unlockTime: "2026-09-23T10:30:56.000Z",
				},
				message: "RESOURCE_EXHAUSTED: dmaas (Too Many Requests)",
			}),
		);

		expect(renderedStderr(spies)).toContain("Roblox Infrastructure Error");
		expect(renderedStderr(spies)).toContain(
			[
				"  Evidence:",
				"    kind: create-quota",
				"    unlockTime: 2026-09-23T10:30:56.000Z",
				"    retryAfterSeconds: 1856",
				"    code: RESOURCE_EXHAUSTED",
				"    placeVersion: 42",
				"    timeoutSeconds: 300",
				"    headers:",
				"      retry-after: 1856",
			].join("\n"),
		);
	});

	it("should return 2 and render a Backend Error banner when error.cause is an OpenCloudError", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const wrapped = new Error("Failed to upload place: Network request failed", {
			cause: new NetworkError("Network request failed"),
		});
		printError(wrapped);

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("Backend Error"));
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Failed to upload place: Network request failed"),
		);
	});

	it("should include the cause chain entries inside the Backend Error banner", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		const innerWithCode = Object.assign(new TypeError("fetch failed"), {
			code: "ECONNRESET",
			errno: -54,
			syscall: "connect",
		});
		const wrapped = new Error("Failed to upload place: Network request failed", {
			cause: new NetworkError("Network request failed", { cause: innerWithCode }),
		});
		printError(wrapped);

		expect(renderedStderr(spies)).toMatchInlineSnapshot(`
			"
			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Backend Error ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

			Failed to upload place: Network request failed

			  Caused by:
			    [0] NetworkError: Network request failed
			    [1] TypeError: fetch failed (code=ECONNRESET errno=-54 syscall=connect)

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

			"
		`);
	});

	it("should name the failing request, status, and body head for a parse failure", () => {
		expect.assertions(4);

		const spies = setupOutputSpies();
		const message = "Failed to parse response body (content-type: application/json)";
		const wrapped = new Error(message, {
			cause: new ApiError(message, {
				cause: new SyntaxError("Unterminated string in JSON at position 1572740"),
				details: '{"path":"universes/1/places/2/luau-execution-session-tasks/abc","sta',
				method: "GET",
				statusCode: 200,
				url: "https://apis.roblox.com/cloud/v2/universes/1/places/2/luau-execution-session-tasks/abc",
			}),
		});
		printError(wrapped);

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("status=200"));
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining(
				"GET https://apis.roblox.com/cloud/v2/universes/1/places/2/luau-execution-session-tasks/abc",
			),
		);
		expect(renderedStderr(spies)).toContain(
			"    [0] ApiError: Failed to parse response body (content-type: application/json) (status=200)",
		);
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining(
				'{"path":"universes/1/places/2/luau-execution-session-tasks/abc',
			),
		);
	});

	it("should collapse and truncate the body head to keep the banner readable", () => {
		expect.assertions(3);

		const spies = setupOutputSpies();
		const wrapped = new Error("Failed to parse response body", {
			cause: new ApiError("Failed to parse response body", {
				details: `{"log":"line one\nline two${"x".repeat(400)}"}`,
				statusCode: 200,
			}),
		});
		printError(wrapped);

		const rendered = renderedStderr(spies);

		expect(rendered).toContain("line one line two");
		expect(rendered).toContain("…");
		expect(rendered).not.toContain("x".repeat(200));
	});

	it("should truncate response bodies only after the preview limit", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const exactLimit = "x".repeat(160);
		printError(
			new Error("Failed to parse response body", {
				cause: new ApiError("Failed to parse response body", {
					details: exactLimit,
					statusCode: 200,
				}),
			}),
		);

		expect(renderedStderr(spies)).toContain(`Body: ${exactLimit}\n`);

		spies.stderr.mockClear();
		printError(
			new Error("Failed to parse response body", {
				cause: new ApiError("Failed to parse response body", {
					details: `${exactLimit}y`,
					statusCode: 200,
				}),
			}),
		);

		expect(renderedStderr(spies)).toContain(`Body: ${exactLimit}…\n`);
	});

	it("should collapse a run of mixed whitespace in a response body", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(
			new Error("Failed to parse response body", {
				cause: new ApiError("Failed to parse response body", {
					details: "first\n \tsecond",
					statusCode: 200,
				}),
			}),
		);

		expect(renderedStderr(spies)).toContain("Body: first second\n");
	});

	it("should omit the body line when the captured body is blank", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		const wrapped = new Error("Failed to parse response body", {
			cause: new ApiError("Failed to parse response body", {
				details: "  \n  ",
				statusCode: 200,
			}),
		});
		printError(wrapped);

		const rendered = renderedStderr(spies);

		expect(rendered).not.toContain("Body:");
	});

	it("should render the url alone when the error names no method", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		const wrapped = new Error("HTTP 503: Service Unavailable", {
			cause: new ApiError("HTTP 503: Service Unavailable", {
				statusCode: 503,
				url: "https://apis.roblox.com/cloud/v2/universes/1/places/2",
			}),
		});
		printError(wrapped);

		const rendered = renderedStderr(spies);

		expect(rendered).toMatchInlineSnapshot(`
			"
			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Backend Error ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

			HTTP 503: Service Unavailable

			  Caused by:
			    [0] ApiError: HTTP 503: Service Unavailable (status=503)
			        https://apis.roblox.com/cloud/v2/universes/1/places/2

			⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

			"
		`);
	});

	it("should name the missing scope in the Backend Error banner for a PermissionError cause", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const wrapped = new Error(
			"Failed to upload place: HTTP 401: API Key has insufficient scopes.",
			{
				cause: new PermissionError("HTTP 401: API Key has insufficient scopes.", {
					operationKey: "places.publishVersion",
					requiredScopes: ["universe-places:write"],
					statusCode: 401,
				}),
			},
		);
		printError(wrapped);

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("universe-places:write"));
		expect(spies.stderr).toHaveBeenCalledWith(
			expect.stringContaining("Add via Creator Dashboard"),
		);
	});

	it("should fall through to plain console.error when error.cause is not an OpenCloudError", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		const wrapped = new Error("wrapped non-ocale", {
			cause: new Error("inner non-ocale"),
		});
		printError(wrapped);

		expect(spies.consoleError).toHaveBeenCalledWith("Error: wrapped non-ocale");
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("Backend Error"));
	});
});

function codedError(message: string, code: RunnerErrorCode): LuauScriptError {
	const error = new LuauScriptError(message);
	error.code = code;
	return error;
}

describe("runner error hints", () => {
	it.for<[code: RunnerErrorCode, hint: string]>([
		[
			"jest-not-found",
			'Set "jestPath" in your config to specify the Jest module location, e.g. "ReplicatedStorage/rbxts_include/node_modules/@rbxts/jest/src"',
		],
		[
			"jest-path-unresolved",
			"The configured jestPath does not resolve to a valid instance. Verify the path matches your Rojo project tree.",
		],
		[
			"service-not-found",
			"The first segment of jestPath must be a valid Roblox service name (e.g. ReplicatedStorage, ServerScriptService).",
		],
		[
			"no-projects",
			'Set "projects" in jest.config.ts (e.g. ["ReplicatedStorage/client", "ServerScriptService/server"]).',
		],
		[
			"infinite-yield",
			"A :WaitForChild() call is waiting for an instance that doesn't exist. Check your DataModel paths and Rojo project configuration.",
		],
	])("should hint for code %s", ([code, hint]) => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(codedError("Some runner failure", code));

		expect(renderedStderr(spies)).toContain(`Hint: ${hint}`);
	});

	it("should give no hint for a timeout", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(codedError("Timed out after 5s, aborting tests", "timeout"));

		expect(renderedStderr(spies)).not.toContain("Hint:");
	});

	it("should not hint on the message alone once the runner sent a code", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(codedError("Studio plugin protocol version mismatch", "timeout"));

		expect(renderedStderr(spies)).not.toContain("Hint:");
	});

	// Verbatim from a v3 plugin, which is the point: the copy that answers
	// is a stale one whose wording is already fixed on disk.
	it("should hint for a plugin version mismatch that carries no code", () => {
		expect.assertions(1);

		const spies = setupOutputSpies();
		printError(
			new LuauScriptError(
				// eslint-disable-next-line flawless/no-em-dash -- Installed plugins print this text verbatim.
				"Studio plugin protocol version mismatch — plugin v3, CLI v6. Update the jest-roblox Studio plugin to match the CLI.",
			),
		);

		expect(renderedStderr(spies)).toContain(
			"Hint: If you have more than one JestRobloxRunner installed, this may be a stale copy rather than the one you just updated: Studio runs them all, and on --backend studio-cli the first to answer decides the run. Check your Studio plugins folder and remove the copies you do not want.",
		);
	});

	it("should not reference removed --projects flag in projects hint", () => {
		expect.assertions(2);

		const spies = setupOutputSpies();
		printError(codedError("No projects configured", "no-projects"));

		expect(spies.stderr).toHaveBeenCalledWith(expect.stringContaining("projects"));
		expect(spies.stderr).not.toHaveBeenCalledWith(expect.stringContaining("--projects"));
	});
});
