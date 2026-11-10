import { COVERAGE_GLOBAL } from "./coverage.ts";
import { BATCH_GAME_OUTPUT_SCOPE, ENTRY_KEY_SEPARATOR } from "./envelope.ts";
import { QUEUE_TTL_SECONDS, RESULT_BUDGET_BYTES, RUN_TIMEOUT_MS } from "./limits.ts";
import {
	RUNNER_TIMEOUT_FORMAT,
	RunnerAbandon,
	RunnerErrorCode,
	RunnerPhase,
} from "./runner-error.ts";
import { RUNNER_KEYS } from "./runner.ts";
import {
	NESTED_PINNED_CLASSES,
	RUN_CONTEXT_ATTRIBUTE,
	SHARED_POOL_ATTRIBUTE,
	SHARED_POOL_NAME,
	STAGE_KEY,
} from "./staged-place.ts";
import {
	DEFAULT_STUDIO_PORT,
	NIL_RELAY_WAIT_SECONDS,
	PLUGIN_KEY_MODULE,
	PLUGIN_VERSION_MODULE,
	RUN_SIDE_CHANNEL_ATTRIBUTE,
	RUN_TESTS_ACTION,
	RUNNING_WAIT_SECONDS,
	STUDIO_FRAME,
	STUDIO_PORT_ATTRIBUTE,
	STUDIO_PROTOCOL_VERSION,
	VM_HOST_READY_ATTRIBUTE,
} from "./studio.ts";

interface LuauTable {
	readonly [key: string]: LuauValue;
}

type LuauValue = LuauTable | number | ReadonlyArray<string> | string;

/** Package-relative path of the generated module. */
export const LUAU_PROTOCOL_MODULE = "luau/protocol.luau";

const LUAU_PROTOCOL: LuauTable = {
	abandons: RunnerAbandon,
	coverage: {
		global: COVERAGE_GLOBAL,
	},
	envelope: {
		batchGameOutputScope: BATCH_GAME_OUTPUT_SCOPE,
		entryKeySeparator: ENTRY_KEY_SEPARATOR,
	},
	errorCodes: RunnerErrorCode,
	limits: {
		queueTtlSeconds: QUEUE_TTL_SECONDS,
		resultBudgetBytes: RESULT_BUDGET_BYTES,
		runTimeoutMs: RUN_TIMEOUT_MS,
	},
	phases: RunnerPhase,
	runner: {
		keys: RUNNER_KEYS,
	},
	stagedPlace: {
		nestedPinnedClasses: NESTED_PINNED_CLASSES,
		runContextAttribute: RUN_CONTEXT_ATTRIBUTE,
		sharedPoolAttribute: SHARED_POOL_ATTRIBUTE,
		sharedPoolName: SHARED_POOL_NAME,
		stageKey: STAGE_KEY,
	},
	studio: {
		defaultPort: DEFAULT_STUDIO_PORT,
		frame: STUDIO_FRAME,
		nilRelayWaitSeconds: NIL_RELAY_WAIT_SECONDS,
		pluginKeyModule: PLUGIN_KEY_MODULE,
		pluginVersionModule: PLUGIN_VERSION_MODULE,
		portAttribute: STUDIO_PORT_ATTRIBUTE,
		protocolVersion: STUDIO_PROTOCOL_VERSION,
		runningWaitSeconds: RUNNING_WAIT_SECONDS,
		runTestsAction: RUN_TESTS_ACTION,
		sideChannelAttribute: RUN_SIDE_CHANNEL_ATTRIBUTE,
		vmHostReadyAttribute: VM_HOST_READY_ATTRIBUTE,
	},
	timeoutFormat: RUNNER_TIMEOUT_FORMAT,
};

/**
 * The Luau module that carries the wire names and constants `src/protocol/`
 * owns, for the plugin, the runners and the materializer to require.
 *
 * @returns Source of {@link LUAU_PROTOCOL_MODULE}.
 */
export function renderLuauProtocol(): string {
	return [
		"--!strict",
		"-- Generated from src/protocol/ by scripts/write-luau-protocol.run.ts. Do not edit.",
		`return ${renderTable(LUAU_PROTOCOL, "")}`,
		"",
	].join("\n");
}

function renderLines(lines: ReadonlyArray<string>, indent: string): string {
	const inner = `${indent}\t`;
	const body = lines.map((line) => inner + line).join("\n");
	return `{\n${body}\n${indent}}`;
}

function isList(value: LuauTable | ReadonlyArray<string>): value is ReadonlyArray<string> {
	return Array.isArray(value);
}

function renderValue(value: LuauValue, indent: string): string {
	if (typeof value === "string") {
		return JSON.stringify(value);
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (isList(value)) {
		return renderLines(
			value.map((item) => `${JSON.stringify(item)},`),
			indent,
		);
	}

	return renderTable(value, indent);
}

function renderTable(table: LuauTable, indent: string): string {
	const inner = `${indent}\t`;
	return renderLines(
		Object.entries(table).map(([key, item]) => `${key} = ${renderValue(item, inner)},`),
		indent,
	);
}
