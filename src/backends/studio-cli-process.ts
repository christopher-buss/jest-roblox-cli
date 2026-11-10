import type { ChildProcess } from "node:child_process";
import process from "node:process";
import type { WebSocketServer } from "ws";

import { isHiddenDesktopPlatform } from "../config/workspace-run-options.ts";
import { launchOnHiddenDesktop } from "./hidden-desktop.ts";
import { findAppBundle, launchHiddenOnMacos } from "./macos-hidden.ts";
import { closePluginServer } from "./plugin-connections.ts";
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

	if (isHiddenDesktopPlatform(platform)) {
		return true;
	}

	if (hiddenDesktop === true) {
		process.stderr.write("Warning: hiddenDesktop is Windows and macOS only; ignoring it.\n");
	}

	return false;
}

/**
 * Kill Studio and close the result server. Never call it after
 * `startGracefulTeardown`: the watch then owns the kill and the close.
 *
 * @param child - The Studio process, absent when the launch never happened.
 * @param server - The loopback result server for this run.
 */
export function hardTeardown(child: StudioCliProcess | undefined, server: WebSocketServer): void {
	child?.kill();
	closePluginServer(server);
}

/**
 * Close the result server, then kill Studio once it releases the place lock.
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
	closePluginServer(server);
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
 * Studio in `--task RunScript` mode ignores SIGTERM on macOS.
 *
 * @param child - The Studio process to kill.
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
