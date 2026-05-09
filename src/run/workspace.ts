import process from "node:process";

import packageJson from "../../package.json" with { type: "json" };
import type { Backend } from "../backends/interface.ts";
import { createOpenCloudBackend } from "../backends/open-cloud.ts";
import { MemoryStoreQueueClient } from "../memory-store/queue-client.ts";
import { runWorkspace } from "../workspace-runner.ts";
import { discoverWorkspaceRoot } from "../workspace/discovery.ts";
import type { PackageInfo } from "../workspace/package-resolver.ts";
import { resolvePackage } from "../workspace/package-resolver.ts";
import type { ProjectResult, RunOptions, WorkspaceRunResult } from "./types.ts";
import {
	buildWorkspaceCredentials,
	resolveWorkspacePackageNames,
	validateWorkspaceFlags,
} from "./workspace-validation.ts";

const VERSION: string = packageJson.version;

const EMPTY_RESULT = {
	merged: {},
	mode: "workspace",
	preCoverageMs: 0,
	projectResults: [],
} as const satisfies WorkspaceRunResult;

interface ResolvedPackages {
	error?: { exitCode: 2; message: string };
	noAffected?: true;
	packageInfos?: Array<PackageInfo>;
	workspaceRoot?: string;
}

export async function runWorkspaceMode(options: RunOptions): Promise<WorkspaceRunResult> {
	const { cli, config } = options;

	const validation = validateWorkspaceFlags(cli, config);
	if (!validation.ok) {
		return {
			...EMPTY_RESULT,
			validationExitCode: validation.exitCode,
			validationMessage: validation.message,
		};
	}

	const resolved = resolvePackages(options);
	if (resolved.error !== undefined) {
		return {
			...EMPTY_RESULT,
			validationExitCode: resolved.error.exitCode,
			validationMessage: resolved.error.message,
		};
	}

	if (resolved.noAffected === true) {
		process.stdout.write("No affected packages — nothing to test.\n");
		return EMPTY_RESULT;
	}

	let backend: Backend;
	let queueClient: MemoryStoreQueueClient;
	try {
		const credentials = buildWorkspaceCredentials(cli, config);
		backend = createOpenCloudBackend(credentials);
		queueClient = new MemoryStoreQueueClient({
			apiKey: credentials.apiKey,
			universeId: credentials.universeId,
		});
	} catch (err) {
		return {
			...EMPTY_RESULT,
			validationExitCode: 2,
			validationMessage: `Error: ${String(err)}\n`,
		};
	}

	let runtimeResults;
	try {
		runtimeResults = await runWorkspace({
			backend,
			cli,
			config,
			// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
			packageInfos: resolved.packageInfos!,
			queueClient,
			version: VERSION,
			// eslint-disable-next-line ts/no-non-null-assertion -- guaranteed when no error/noAffected
			workspaceRoot: resolved.workspaceRoot!,
		});
	} finally {
		await backend.close?.();
	}

	if (runtimeResults === undefined) {
		return { ...EMPTY_RESULT, validationExitCode: 2 };
	}

	if (runtimeResults.length === 0) {
		return EMPTY_RESULT;
	}

	const projectResults: Array<ProjectResult> = runtimeResults.map((entry) => {
		return {
			displayName: composeWorkspaceDisplayName(entry.pkg, entry.displayName),
			result: entry.result,
		};
	});

	return {
		merged: {},
		mode: "workspace",
		preCoverageMs: 0,
		projectResults,
	};
}

function resolvePackages(options: RunOptions): ResolvedPackages {
	const { cli } = options;
	try {
		const workspaceRoot = discoverWorkspaceRoot(process.cwd());
		const packageNames = resolveWorkspacePackageNames(cli, workspaceRoot);

		if (packageNames.length === 0) {
			// validateWorkspaceFlags requires --affected-since when --packages
			// produces zero entries, so we can only land here via that branch.
			return { noAffected: true };
		}

		const packageInfos = packageNames.map((name) => resolvePackage(workspaceRoot, name));
		return { packageInfos, workspaceRoot };
	} catch (err) {
		return { error: { exitCode: 2, message: `Error: ${String(err)}\n` } };
	}
}

function composeWorkspaceDisplayName(package_: string, project: string): string {
	return package_ === project ? package_ : `${package_} › ${project}`;
}
