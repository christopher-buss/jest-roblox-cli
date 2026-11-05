import type { Except } from "type-fest";
import type { WebSocket } from "ws";

import type { FileSystem } from "../utils/file-system.ts";

/** Overrides how long Studio may take to start the run, in milliseconds. */
export const BOOT_TIMEOUT_ENV = "JEST_ROBLOX_STUDIO_BOOT_TIMEOUT";

/** Splits Studio's log on either line ending — it writes CRLF on Windows. */
const LOG_LINE_SPLIT_PATTERN = /\r?\n/u;

/** Lines of Studio's engine log quoted when a run times out. */
const STUDIO_LOG_TAIL = 15;

/** Per-line cap on the quoted Studio log tail, in characters. */
const STUDIO_LOG_LINE_LIMIT = 300;

// Must stay below `NIL_RELAY_WAIT_SECONDS` and above `RUNNING_WAIT_SECONDS` in
// `plugin/src/test-in-run-mode.server.luau`.
const NIL_RETURN_PLUGIN_WAIT_MS = 30_000;

const NIL_RETURN_HEADLINE =
	"studio-cli: ExecuteRunModeAsync ended the test session early (it returned nil), " +
	`and no run-mode plugin took the run over within ${NIL_RETURN_PLUGIN_WAIT_MS.toString()}ms.`;

/** How long a run may go unanswered, and where to look when it does. */
export interface ResultDeadline {
	/** Wall clock in milliseconds from launch to the run starting. */
	bootTimeout: number;
	/** Studio's engine log, quoted back when the run never answers. */
	outputFile: string;
	/** Wall clock in milliseconds from the run starting to its result. */
	timeout: number;
}

/** Answers a nil run return by asking the plugin to relay the result. */
export interface NilReturnRelay {
	/** Stops the pending expiry timer. */
	clear: () => void;
	/** Asks each ready plugin to relay, and starts the expiry timer. */
	onNilReturn: () => void;
	/** Records a ready plugin; relays to it when a nil return is pending. */
	onPluginReady: (socket: WebSocket) => void;
}

interface NilReturnRelayOptions extends Pick<ResultDeadline, "outputFile"> {
	fileSystem: FileSystem;
	onExpired: (error: Error) => void;
	pluginKey: string | undefined;
	requestId: string;
}

/**
 * The boot deadline runs from launch until the run starts; the run deadline
 * from then until the result. Either one expiring hands `onExpired` the
 * error.
 *
 * @param options - Both timeouts, the log path, and the expiry callback.
 * @returns Controls that stop the deadlines or mark the run as started.
 */
export function startRunDeadlines({
	bootTimeout,
	fileSystem,
	onExpired,
	outputFile,
	timeout,
}: ResultDeadline & {
	fileSystem: FileSystem;
	onExpired: (error: Error) => void;
}): {
	/** Stops the active deadline. */
	clear: () => void;
	/** Ends the boot deadline and starts the run deadline. */
	markStarted: () => void;
} {
	function arm(ms: number, headline: string): NodeJS.Timeout {
		return setTimeout(() => {
			onExpired(unansweredError({ fileSystem, headline, outputFile }));
		}, ms);
	}

	let isBooting = true;
	let timer = arm(bootTimeout, bootTimeoutHeadline(bootTimeout));

	return {
		clear: () => {
			isBooting = false;
			clearTimeout(timer);
		},
		markStarted: () => {
			if (!isBooting) {
				return;
			}

			isBooting = false;
			clearTimeout(timer);
			timer = arm(
				timeout,
				`studio-cli: Studio run timed out after ${timeout.toString()}ms and was terminated.`,
			);
		},
	};
}

/**
 * Starts a relay that answers a nil run return through the plugin socket.
 *
 * @param options - Request ID, plugin key, log path, and the expiry callback.
 * @returns The relay controls.
 */
export function startNilReturnRelay({
	onExpired,
	requestId,
	...unanswered
}: NilReturnRelayOptions): NilReturnRelay {
	// Remove the nil relay once Roblox fixes
	// https://devforum.roblox.com/t/executerunmodeasync-returns-nil-when-called-from-task-runscript-before-the-place-reaches-placeidle/4921336
	const pluginSockets = new Set<WebSocket>();
	let timer: NodeJS.Timeout | undefined;

	function relayTo(socket: WebSocket): void {
		socket.send(JSON.stringify({ requestId, type: "nilRelay" }));
		clearTimeout(timer);
	}

	return {
		clear: () => {
			clearTimeout(timer);
		},
		onNilReturn: () => {
			if (timer !== undefined) {
				return;
			}

			timer = setTimeout(() => {
				onExpired(nilReturnError(unanswered));
			}, NIL_RETURN_PLUGIN_WAIT_MS);
			for (const socket of pluginSockets) {
				relayTo(socket);
			}
		},
		onPluginReady: (socket) => {
			pluginSockets.add(socket);
			if (timer !== undefined) {
				relayTo(socket);
			}
		},
	};
}

/**
 * The tail of Studio's own engine log, or nothing when it holds nothing worth
 * printing.
 *
 * Studio's stdio is discarded (see `spawnStudio`), so `--outputFile` is
 * the only channel that survives a run the result socket never answered. It is
 * not a guarantee: a place Studio cannot open stops behind a modal dialog with
 * only the echoed bootstrap flushed, which is exactly why the timeout names the
 * file as well as quoting it.
 *
 * @param fileSystem - File system the log is read through.
 * @param outputFile - Path Studio was told to log to.
 * @returns Trailing log lines, oldest first, or an empty array.
 */
function readStudioLogTail(fileSystem: FileSystem, outputFile: string): Array<string> {
	let contents;
	try {
		contents = fileSystem.readFileSync(outputFile, "utf-8");
	} catch {
		return [];
	}

	return contents
		.split(LOG_LINE_SPLIT_PATTERN)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(-STUDIO_LOG_TAIL)
		.map((line) => {
			return line.length > STUDIO_LOG_LINE_LIMIT
				? `${line.slice(0, STUDIO_LOG_LINE_LIMIT)}…`
				: line;
		});
}

/**
 * Names a run Studio never answered, and hands over whatever Studio did log.
 *
 * A bare "timed out" is the least useful thing the backend can say: the run
 * could have wedged in a test, failed to open the place, or died behind a
 * dialog, and Studio's engine log is the only place those read differently.
 *
 * @param options - Log reader, headline, and log path.
 * @param options.fileSystem - File system the log is read through.
 * @param options.headline - What ran out, and any probable cause, as the
 *   opening lines of the error.
 * @param options.outputFile - Path Studio was told to log to.
 * @returns The error to reject the run with.
 */
function unansweredError({
	fileSystem,
	headline,
	outputFile,
}: {
	fileSystem: FileSystem;
	headline: string;
	outputFile: string;
}): Error {
	const lines = [headline, `  Studio log: ${outputFile}`];
	const tail = readStudioLogTail(fileSystem, outputFile);
	if (tail.length > 0) {
		lines.push("  Last lines Studio logged:");
		for (const line of tail) {
			lines.push(`    ${line}`);
		}
	}

	return new Error(lines.join("\n"));
}

function bootTimeoutHeadline(bootTimeout: number): string {
	return [
		`studio-cli: Studio did not start the run within ${bootTimeout.toString()}ms and was terminated.`,
		"  Probable cause: Studio is not logged in. Open Roblox Studio, log in, then run again.",
		`  On a slow machine, set ${BOOT_TIMEOUT_ENV} to allow a slower boot.`,
	].join("\n");
}

function nilReturnError({
	pluginKey,
	...unanswered
}: Except<NilReturnRelayOptions, "onExpired" | "requestId">): Error {
	const headline =
		pluginKey === undefined
			? NIL_RETURN_HEADLINE
			: `${NIL_RETURN_HEADLINE}\n  No copy of the Studio plugin ${pluginKey} answered: it did not load, Studio refused it a socket, or the play server never started running.`;
	return unansweredError({ ...unanswered, headline });
}
