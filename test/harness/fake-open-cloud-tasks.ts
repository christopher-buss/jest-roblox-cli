import { validInProgressTaskBody } from "@bedrock-rbx/ocale/testing";

import type { ServerResponse } from "node:http";

import type { TaskEnvelope } from "#src/protocol/envelope.ts";
import { BOOT_PROBE_SCRIPT } from "#src/protocol/open-cloud.ts";
import {
	createTaskRequestSchema,
	type FakeOpenCloudState,
	JSON_CONTENT_TYPE,
} from "#test/harness/fake-open-cloud-state.ts";
import type { FakeOpenCloudOptions, FakeOpenCloudTask } from "#test/harness/fake-open-cloud.ts";

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
	} catch (err) {
		response.writeHead(400, { "content-type": JSON_CONTENT_TYPE });
		response.end(
			JSON.stringify({ error: { message: `Invalid request body: ${String(err)}` } }),
		);
		return;
	}

	if (parsed.script === BOOT_PROBE_SCRIPT) {
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

	acceptQueuedTask({ response, script: parsed.script, state });
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

const WORKSPACE_JOB_PATTERN = /"runnerJobIndex":(\d+)\},"pkg":"([^"]*)","project":"([^"]*)"/g;
const FIRST_JOB_PATTERN = /"runnerJobIndex":(\d+)/;

/**
 * The job index a submitted script gives the task's package and project, or
 * its first job's index when the task names no package.
 * @param script - The submitted script.
 * @param queuedTask - Task whose package and project to look up.
 * @returns The job index, or 0 when the script names none.
 */
function scriptJobIndex(script: string, { pkg, project }: FakeOpenCloudTask): number {
	for (const match of script.matchAll(WORKSPACE_JOB_PATTERN)) {
		if (match[2] === pkg && (project === undefined || match[3] === project)) {
			return Number(match[1]);
		}
	}

	const first = FIRST_JOB_PATTERN.exec(script);
	return first === null ? 0 : Number(first[1]);
}

function acceptQueuedTask({
	response,
	script,
	state,
}: {
	response: ServerResponse;
	script: string;
	state: FakeOpenCloudState;
}): void {
	const nextTask = state.taskQueue.shift();
	if (nextTask === undefined) {
		response.writeHead(500, { "content-type": JSON_CONTENT_TYPE });
		response.end(JSON.stringify({ error: { message: "No fake task queued" } }));
		return;
	}

	acceptTask({
		queuedTask: { jobIndex: scriptJobIndex(script, nextTask), ...nextTask },
		response,
		state,
	});
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
				gameOutput: queuedTask.gameOutput,
				jestOutput: queuedTask.jestOutput ?? "",
				jobIndex: queuedTask.jobIndex ?? 0,
			},
		],
	} satisfies TaskEnvelope);
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
