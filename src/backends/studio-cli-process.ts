import type { ChildProcess } from "node:child_process";
import process from "node:process";
import type { WebSocketServer } from "ws";

import { launchOnHiddenDesktop } from "./hidden-desktop.ts";
import { findAppBundle, launchHiddenOnMacos } from "./macos-hidden.ts";
import type { StudioCliLaunchRequest, StudioCliProcess } from "./studio-cli-types.ts";
import { clearStaleLock, watchLockRelease } from "./studio-lock.ts";

const SIGTERM_GRACE_MS = 5000;

const UNBUNDLED_WARNING =
	"Warning: Studio is not inside an .app bundle, so it cannot launch hidden.\n";

/**
 * Decide whether Studio launches hidden.
 *
 * @param options - Headed flag, hidden-desktop setting, and platform.
 * @returns True on Windows and macOS unless headed or turned off.
 */
export function resolveHiddenDesktop({
	headed = false,
	hiddenDesktop,
	platform,
}: {
	readonly headed?: boolean | undefined;
	readonly hiddenDesktop?: boolean | undefined;
	readonly platform: NodeJS.Platform;
}): boolean {
	if (headed || hiddenDesktop === false) {
		return false;
	}

	if (platform === "win32" || platform === "darwin") {
		return true;
	}

	if (hiddenDesktop === true) {
		process.stderr.write("Warning: hiddenDesktop is Windows and macOS only; ignoring it.\n");
	}

	return false;
}

/**
 * Wind a run down the hard way: every error path before the graceful teardown
 * began (timeout, spawn failure, server error — a hung run gets no graceful
 * wait). Kills Studio so node's event loop can drain and the CLI exits, then
 * releases the result server. Not called once the graceful watch has started:
 * from then on the watch owns both the kill and the close.
 *
 * @param child - The Studio process, absent when the launch never happened.
 * @param server - The loopback result server for this run.
 */
export function hardTeardown(child: StudioCliProcess | undefined, server: WebSocketServer): void {
	child?.kill();
	closeServer(server);
}

/**
 * Wind a run down now that the result is in hand, decoupling teardown from it:
 * close the result server (so the bootstrap returns and `--quitAfterExecution`
 * begins a graceful `ClosePlace` that runs edit-mode `BindToClose` handlers and
 * frees the lock), then kill the instant the lock releases — skipping Studio's
 * ~30s telemetry drain. The watch is non-awaited, so results return now and the
 * process exits after teardown.
 *
 * @param options - Teardown inputs.
 * @param options.child - The Studio process that answered.
 * @param options.graceCapMs - Backstop before the watch hard-kills anyway.
 * @param options.server - The loopback result server for this run.
 */
export function startGracefulTeardown({
	child,
	graceCapMs,
	server,
}: {
	readonly child: StudioCliProcess;
	readonly graceCapMs: number;
	readonly server: WebSocketServer;
}): void {
	closeServer(server);
	child.killOnLockRelease(graceCapMs);
}

/**
 * Launch Studio for a run: hidden when asked and supported, else visible.
 *
 * @param request - Studio path, arguments, place file, and launch mode.
 * @returns A handle that kills Studio and reports launch failures.
 */
export function launchStudioProcess(request: StudioCliLaunchRequest): StudioCliProcess {
	if (!request.hiddenDesktop) {
		return spawnStudio(request);
	}

	if (request.platform === "win32") {
		return launchOnHiddenDesktop(request);
	}

	const bundle = findAppBundle(request.studioPath);
	if (bundle === undefined) {
		process.stderr.write(UNBUNDLED_WARNING);
		return spawnStudio(request);
	}

	return launchHiddenOnMacos(request, bundle);
}

/**
 * Terminate any live bootstrap socket and close the result server so a
 * lingering connection can't keep node's event loop running past the CLI's
 * exitCode-based shutdown (the same hazard the WebSocket `studio` backend
 * guards against).
 *
 * @param server - The loopback result server for this run.
 */
function closeServer(server: WebSocketServer): void {
	for (const client of server.clients) {
		client.terminate();
	}

	server.close();
}

/**
 * Studio in `--task RunScript` mode ignores SIGTERM on macOS, and a live child
 * holds node's event loop open, so the CLI would never exit.
 *
 * @param child - The Studio process.
 */
function terminateStudio(child: ChildProcess): void {
	const escalation = setTimeout(() => {
		child.kill("SIGKILL");
		child.unref();
	}, SIGTERM_GRACE_MS);
	escalation.unref();
	child.once("exit", () => {
		clearTimeout(escalation);
	});
	child.kill("SIGTERM");
}

/**
 * Real launcher: clear a stale `<place>.lock` (a previously killed Studio
 * can't remove its own, and a back-to-back run would otherwise open the place
 * onto it and crash), then spawn Studio and return the handle the host kills.
 * The result arrives over the WebSocket, not the process — the host kills this
 * Studio once it lands (instantly, or after a graceful close; see {@link
 * StudioCliProcess}).
 *
 * `stdio: "ignore"` because nothing is read from the pipes — an unconsumed
 * `stdout` pipe could backpressure-stall a chatty Studio.
 *
 * @param request - Studio path, arguments, place file, and process runner.
 * @returns A handle that kills Studio and reports launch failures.
 */
function spawnStudio(request: StudioCliLaunchRequest): StudioCliProcess {
	const { childProcess, fileSystem } = request;
	const lockFile = clearStaleLock(fileSystem, request.placeFile);

	// headed mode intentionally shows the Studio window; `!request.headed` is
	// the deliberate lever, not an accidental terminal popup.
	const child = childProcess.spawn(request.studioPath, request.args, {
		stdio: "ignore",
		windowsHide: !request.headed,
	});

	return {
		kill: () => {
			terminateStudio(child);
		},
		killOnLockRelease: (graceCapMs) => {
			watchLockRelease({
				fileSystem,
				graceCapMs,
				lockFile,
				terminate: () => {
					terminateStudio(child);
				},
			});
		},
		onError: (listener) => {
			child.on("error", listener);
		},
	};
}
