import { validInProgressTaskBody } from "@bedrock-rbx/ocale/testing";

import type { ServerResponse } from "node:http";

import {
	createTaskRequestSchema,
	type FakeOpenCloudState,
	JSON_CONTENT_TYPE,
} from "#test/e2e/cli/fake-open-cloud-state.ts";
import type { FakeOpenCloudOptions, FakeOpenCloudTask } from "#test/e2e/cli/fake-open-cloud.ts";

const LOGS_SUFFIX_PATTERN = /\/logs$/;

interface TaskRequest {
	response: ServerResponse;
	state: FakeOpenCloudState;
	url: URL;
}

export function handleCreateTask({
	body,
	response,
	state,
}: {
	body: string;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	let parsed;
	try {
		parsed = createTaskRequestSchema.assert(JSON.parse(body));
	} catch {
		response.writeHead(400, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "Invalid request body" } }));
		return;
	}

	if (parsed.script === "return tostring(game.PlaceVersion)") {
		const answer = state.bootProbes.shift() ?? "complete";
		acceptTask({
			queuedTask: {
				// A stalled task never reaches a terminal state.
				pollsBeforeComplete: answer === "stall" ? Number.MAX_SAFE_INTEGER : 0,
				rawOutput: String(state.counters.uploadCount),
			},
			response,
			state,
		});
		return;
	}

	state.requests.push(parsed);
	if (rejectConfiguredSubmission(state, response)) {
		return;
	}

	acceptQueuedTask(state, response);
}

/**
 * Serve a task's structured log page. Live Open Cloud writes these only once a
 * task is terminal, so a task the fake never completes has nothing to return —
 * the same empty page the live endpoint gives while a task is still running.
 * @param options - Response, fake state and request URL.
 */
export function handleListLogs({ response, state, url }: TaskRequest): void {
	const taskPath = url.pathname.replace("/cloud/v2/", "").replace(LOGS_SUFFIX_PATTERN, "");
	const queuedTask = state.taskResults.get(taskPath);
	const messages = queuedTask?.logs ?? [];

	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(
		JSON.stringify({
			luauExecutionSessionTaskLogs: [
				{
					path: `${taskPath}/logs/1`,
					structuredMessages: messages.map((entry) => {
						return { ...entry, createTime: "2026-01-01T00:00:00Z" };
					}),
				},
			],
		}),
	);
}

export function handlePoll({ response, state, url }: TaskRequest): void {
	const taskPath = url.pathname.replace("/cloud/v2/", "");
	const remainingPolls = state.pollCounts.get(taskPath);
	const queuedTask = state.taskResults.get(taskPath);

	if (queuedTask === undefined || remainingPolls === undefined) {
		response.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "Unknown fake task" } }));
		return;
	}

	if (remainingPolls > 0) {
		state.pollCounts.set(taskPath, remainingPolls - 1);
		response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
		response.end(
			JSON.stringify(validInProgressTaskBody({ path: taskPath, state: "PROCESSING" })),
		);
		return;
	}

	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify(buildCompletedTaskBody({ queuedTask, taskPath })));
}

/**
 * Register a task under a fresh path and answer the submit with it.
 * @param options - Task to register, response and fake state.
 */
function acceptTask({
	queuedTask,
	response,
	state,
}: {
	queuedTask: FakeOpenCloudTask;
	response: ServerResponse;
	state: FakeOpenCloudState;
}): void {
	state.counters.taskIndex += 1;
	const taskIndex = String(state.counters.taskIndex);
	const taskPath = `universes/123/places/456/versions/1/luau-execution-sessions/session-${taskIndex}/tasks/task-${taskIndex}`;
	state.taskResults.set(taskPath, queuedTask);
	state.pollCounts.set(taskPath, queuedTask.pollsBeforeComplete ?? 0);
	response.writeHead(200, { "content-type": JSON_CONTENT_TYPE });
	response.end(JSON.stringify(validInProgressTaskBody({ path: taskPath })));
}

function rejectTaskSubmission(
	response: ServerResponse,
	submitFailure: NonNullable<FakeOpenCloudOptions["submitFailures"]>[number],
): void {
	response.writeHead(submitFailure.status, {
		"content-type": JSON_CONTENT_TYPE,
		...submitFailure.headers,
	});
	response.end(JSON.stringify(submitFailure.body));
}

function rejectConfiguredSubmission(state: FakeOpenCloudState, response: ServerResponse): boolean {
	const submitFailure = state.submitFailures.shift();
	if (submitFailure === undefined) {
		return false;
	}

	rejectTaskSubmission(response, submitFailure);

	return true;
}

function acceptQueuedTask(state: FakeOpenCloudState, response: ServerResponse): void {
	const nextTask = state.taskQueue.shift();
	if (nextTask === undefined) {
		response.writeHead(500, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "No fake task queued" } }));
		return;
	}

	acceptTask({ queuedTask: nextTask, response, state });
}

/**
 * The auto-wrapped envelope entry returned when no `rawOutput` is supplied.
 * @param queuedTask - Task whose fields fill the entry.
 * @returns Serialized envelope.
 */
function buildJestEnvelope(queuedTask: FakeOpenCloudTask): string {
	return JSON.stringify({
		entries: [
			{
				elapsedMs: queuedTask.elapsedMs ?? 25,
				gameOutput: queuedTask.gameOutput,
				jestOutput: queuedTask.jestOutput ?? "",
				pkg: queuedTask.pkg,
				project: queuedTask.project,
				snapshotWrites: queuedTask.snapshotWrites,
			},
		],
	});
}

function buildCompletedTaskBody({
	queuedTask,
	taskPath,
}: {
	queuedTask: FakeOpenCloudTask;
	taskPath: string;
}): ReturnType<typeof validInProgressTaskBody> {
	if (queuedTask.state === "FAILED") {
		return validInProgressTaskBody({
			error: {
				code: "SCRIPT_ERROR",
				message: queuedTask.errorMessage ?? "Execution failed",
			},
			path: taskPath,
			state: "FAILED",
		});
	}

	if (queuedTask.rawOutput !== undefined) {
		return validInProgressTaskBody({
			output: { results: [queuedTask.rawOutput] },
			path: taskPath,
			state: "COMPLETE",
		});
	}

	return validInProgressTaskBody({
		output: { results: [buildJestEnvelope(queuedTask)] },
		path: taskPath,
		state: "COMPLETE",
	});
}
