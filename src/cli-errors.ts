import { OpenCloudError } from "@bedrock-rbx/ocale";
import type { InfrastructureEvidence } from "@isentinel/roblox-runner";

import process from "node:process";
import color from "tinyrainbow";

import { ConfigError } from "./config/errors.ts";
import { parseGameOutput } from "./game-output/game-output.ts";
import { LuauScriptError } from "./jest-output/luau-script-error.ts";
import type { RunnerErrorCode } from "./protocol/runner-error.ts";
import { formatBanner } from "./terminal/banner.ts";
import { type ChainEntry, formatMissingScopes, walkErrorChain } from "./utils/error-chain.ts";
import {
	type InfrastructureFailure,
	isInfrastructureFailure,
	MissingGapRecordError,
} from "./utils/infrastructure-failure.ts";

function formatGameOutputLines(raw: string | undefined): string | undefined {
	const entries = parseGameOutput(raw);
	if (entries.length === 0) {
		return undefined;
	}

	return entries.map((entry) => entry.message.replace(/^/gm, "  ")).join("\n");
}

const EXIT_CODE_MESSAGE = /^Exited with code: \d+$/;

function formatLuauErrorBanner(err: LuauScriptError): string {
	const bannerLines = formatGameOutputLines(err.bannerOutput);

	if (bannerLines !== undefined && EXIT_CODE_MESSAGE.test(err.message)) {
		const body = [bannerLines, `\n  ${color.dim(err.message)}`];
		return formatBanner({ body, level: "error", title: "Test Run Failed" });
	}

	const body = [color.red(err.message)];

	const hint = getLuauErrorHint(err);
	if (hint !== undefined) {
		body.push(`\n  ${color.dim("Hint:")} ${hint}`);
	}

	if (bannerLines !== undefined) {
		body.push(`\n  ${color.dim("Game output:")}\n${bannerLines}`);
	}

	return formatBanner({ body, level: "error", title: "Luau Error" });
}

const BODY_PREVIEW_LIMIT = 160;

/**
 * Write a formatted error banner to stderr.
 * @param err - The thrown value.
 */
export function printError(err: unknown): void {
	if (err instanceof ConfigError) {
		const body = [color.red(err.message)];
		if (err.hint !== undefined) {
			body.push(`\n  ${color.dim("Hint:")} ${err.hint}`);
		}

		process.stderr.write(formatBanner({ body, level: "error", title: "Config Error" }));
	} else if (err instanceof LuauScriptError) {
		process.stderr.write(formatLuauErrorBanner(err));
	} else if (isInfrastructureFailure(err)) {
		process.stderr.write(formatInfrastructureBanner(err));
	} else if (err instanceof Error && err.cause instanceof OpenCloudError) {
		process.stderr.write(formatBackendErrorBanner(err));
	} else if (err instanceof Error) {
		console.error(`Error: ${err.message}`);
	} else {
		console.error("An unknown error occurred");
	}
}

function formatChainExtras(entry: ChainEntry): string {
	const pieces: Array<string> = [];
	if (entry.statusCode !== undefined) {
		pieces.push(`status=${entry.statusCode.toString()}`);
	}

	if (entry.code !== undefined) {
		pieces.push(`code=${entry.code}`);
	}

	if (entry.errno !== undefined) {
		pieces.push(`errno=${entry.errno}`);
	}

	if (entry.syscall !== undefined) {
		pieces.push(`syscall=${entry.syscall}`);
	}

	return pieces.length > 0 ? color.dim(` (${pieces.join(" ")})`) : "";
}

function formatBodyPreview(details: string | undefined): string | undefined {
	if (details === undefined) {
		return undefined;
	}

	const collapsed = details.replaceAll(/\s+/gu, " ").trim();
	if (collapsed === "") {
		return undefined;
	}

	return collapsed.length > BODY_PREVIEW_LIMIT
		? `${collapsed.slice(0, BODY_PREVIEW_LIMIT)}…`
		: collapsed;
}

function formatChainDetailLines(entry: ChainEntry): Array<string> {
	const lines: Array<string> = [];
	if (entry.url !== undefined) {
		const method = entry.method === undefined ? "" : `${entry.method} `;
		const request = color.dim(`${method}${entry.url}`);
		lines.push(`        ${request}`);
	}

	const preview = formatBodyPreview(entry.details);
	if (preview !== undefined) {
		lines.push(`        ${color.dim("Body:")} ${preview}`);
	}

	if (entry.requiredScopes !== undefined) {
		lines.push(`        ${color.yellow(formatMissingScopes(entry.requiredScopes))}`);
	}

	return lines;
}

function formatBackendErrorBanner(err: Error): string {
	const body: Array<string> = [color.red(err.message)];
	const chain = walkErrorChain(err.cause);
	body.push(`\n  ${color.dim("Caused by:")}`);
	for (const [index, entry] of chain.entries()) {
		const extras = formatChainExtras(entry);
		const label = color.dim(`[${index.toString()}]`);
		body.push(
			`    ${label} ${entry.name}: ${entry.message}${extras}`,
			...formatChainDetailLines(entry),
		);
	}

	return formatBanner({ body, level: "error", title: "Backend Error" });
}

const RUNNER_ERROR_HINTS: Record<RunnerErrorCode, string | undefined> = {
	"infinite-yield":
		"A :WaitForChild() call is waiting for an instance that doesn't exist. Check your DataModel paths and Rojo project configuration.",
	"jest-not-found":
		'Set "jestPath" in your config to specify the Jest module location, e.g. "ReplicatedStorage/rbxts_include/node_modules/@rbxts/jest/src"',
	"jest-path-unresolved":
		"The configured jestPath does not resolve to a valid instance. Verify the path matches your Rojo project tree.",
	"no-projects":
		'Set "projects" in jest.config.ts (e.g. ["ReplicatedStorage/client", "ServerScriptService/server"]).',
	"service-not-found":
		"The first segment of jestPath must be a valid Roblox service name (e.g. ReplicatedStorage, ServerScriptService).",
	"timeout": undefined,
};

// Matches the mismatch wording of every plugin version, old ones included.
const PLUGIN_MISMATCH = /protocol version mismatch/i;

const PLUGIN_MISMATCH_HINT =
	"If you have more than one JestRobloxRunner installed, this may be a stale copy rather than the one you just updated: Studio runs them all, and on --backend studio-cli the first to answer decides the run. Check your Studio plugins folder and remove the copies you do not want.";

function getLuauErrorHint(err: LuauScriptError): string | undefined {
	if (err.code !== undefined) {
		return RUNNER_ERROR_HINTS[err.code];
	}

	return PLUGIN_MISMATCH.test(err.message) ? PLUGIN_MISMATCH_HINT : undefined;
}

function listFields(
	evidence: InfrastructureEvidence,
): Array<[name: string, value: number | string | undefined]> {
	if (evidence.kind === "task-stall") {
		return [
			["task", evidence.task],
			["placeVersion", evidence.placeVersion],
			["timeoutSeconds", evidence.timeoutSeconds],
			["createTime", evidence.createTime],
			["updateTime", evidence.updateTime],
			["observedStates", evidence.observedStates.join(", ")],
		];
	}

	return [
		["unlockTime", evidence.unlockTime],
		["retryAfterSeconds", evidence.retryAfterSeconds],
		["code", evidence.code],
		["placeVersion", evidence.placeVersion],
		["timeoutSeconds", evidence.timeoutSeconds],
	];
}

function describeEvidence(evidence: InfrastructureEvidence): Array<string> {
	const lines = [`    kind: ${evidence.kind}`];
	for (const [name, value] of listFields(evidence)) {
		if (value !== undefined) {
			lines.push(`    ${name}: ${String(value)}`);
		}
	}

	if (evidence.kind === "create-quota") {
		lines.push("    headers:");
		for (const [name, value] of Object.entries(evidence.headers)) {
			lines.push(`      ${name}: ${value}`);
		}
	}

	return lines;
}

/**
 * Render the error banner for an infrastructure failure, with its evidence.
 * @param err - The infrastructure failure.
 * @returns The banner text.
 */
function formatInfrastructureBanner(err: InfrastructureFailure): string {
	if (err instanceof MissingGapRecordError) {
		return formatBanner({
			body: [color.red(err.message)],
			level: "error",
			title: "Missing Gap Record",
		});
	}

	const body = [
		color.red(err.message),
		`\n  ${color.dim("Evidence:")}`,
		...describeEvidence(err.evidence),
	];
	return formatBanner({ body, level: "error", title: "Roblox Infrastructure Error" });
}
