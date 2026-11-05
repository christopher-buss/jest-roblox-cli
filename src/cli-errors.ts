import { OpenCloudError } from "@bedrock-rbx/ocale";

import process from "node:process";
import color from "tinyrainbow";

import { ConfigError } from "./config/errors.ts";
import { LuauScriptError } from "./reporter/luau-script-error.ts";
import { formatBanner } from "./utils/banner.ts";
import { type ChainEntry, formatMissingScopes, walkErrorChain } from "./utils/error-chain.ts";
import { parseGameOutput } from "./utils/game-output.ts";
import {
	formatInfrastructureBanner,
	isInfrastructureFailure,
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

	// When the message is just "Exited with code: N", Jest's real error is in
	// the captured stdout, not in the message itself — surface stdout as the
	// primary content and demote the exit-code transport to a dim footer.
	if (bannerLines !== undefined && EXIT_CODE_MESSAGE.test(err.message)) {
		const body = [bannerLines, `\n  ${color.dim(err.message)}`];
		return formatBanner({ body, level: "error", title: "Test Run Failed" });
	}

	const body = [color.red(err.message)];

	const hint = getLuauErrorHint(err.message);
	if (hint !== undefined) {
		body.push(`\n  ${color.dim("Hint:")} ${hint}`);
	}

	if (bannerLines !== undefined) {
		body.push(`\n  ${color.dim("Game output:")}\n${bannerLines}`);
	}

	return formatBanner({ body, level: "error", title: "Luau Error" });
}

/**
 * How much of a captured response body the banner shows. A parse failure hands
 * over 500 bytes of minified JSON; the opening object keys are what name the
 * call that returned it, and the rest only buries the cause chain below it.
 */
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

/**
 * One-line preview of a captured response body. Whitespace is collapsed so a
 * body that is itself several lines cannot push the rest of the chain off the
 * screen.
 *
 * @param details - The captured response body.
 * @returns The capped preview, or `undefined` when the body is absent or blank.
 */
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

/**
 * The indented lines that hang under one chain entry. Each appears only when
 * the error carried it: ocale names the failing request on an error response
 * but not on a 2xx body it could not parse, where the body head is the only
 * thing that says which call returned it.
 *
 * @param entry - One entry of the error cause chain.
 * @returns The detail lines, empty when the entry carries none.
 */
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

const LUAU_ERROR_HINTS: Array<[pattern: RegExp, hint: string]> = [
	[
		/Failed to find Jest instance in ReplicatedStorage/,
		'Set "jestPath" in your config to specify the Jest module location, e.g. "ReplicatedStorage/rbxts_include/node_modules/@rbxts/jest/src"',
	],
	[
		/Failed to find Jest instance at path/,
		"The configured jestPath does not resolve to a valid instance. Verify the path matches your Rojo project tree.",
	],
	[
		/Failed to find service/,
		"The first segment of jestPath must be a valid Roblox service name (e.g. ReplicatedStorage, ServerScriptService).",
	],
	[
		/No projects configured/,
		'Set "projects" in jest.config.ts (e.g. ["ReplicatedStorage/client", "ServerScriptService/server"]).',
	],
	[
		/Infinite yield detected/,
		"A :WaitForChild() call is waiting for an instance that doesn't exist. Check your DataModel paths and Rojo project configuration.",
	],
	[
		/loadstring\(\) is not available/,
		'loadstring() must be enabled for Jest to run. Add "LoadStringEnabled": true to ServerScriptService.$properties in your project.json.',
	],
	// Matches the wording every plugin version uses, including the ones that
	// predate this hint — the copy that reports the mismatch is by definition
	// not the one that could be taught to explain it.
	[
		/protocol version mismatch/i,
		"If you have more than one JestRobloxRunner installed, this may be a stale copy rather than the one you just updated: Studio runs them all, and on --backend studio-cli the first to answer decides the run. Check your Studio plugins folder and remove the copies you do not want.",
	],
];

function getLuauErrorHint(message: string): string | undefined {
	for (const [pattern, hint] of LUAU_ERROR_HINTS) {
		if (pattern.test(message)) {
			return hint;
		}
	}

	return undefined;
}
