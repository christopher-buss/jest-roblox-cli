import type { CliOptions } from "../config/resolved-config.ts";
import type { ChildProcessRunner } from "../utils/child-process.ts";
import type { FileSystem } from "../utils/file-system.ts";
import { getAffectedPackages } from "./affected.ts";
import {
	enumerateWorkspacePackages,
	type EnumerationOptions,
	excludePackages,
	type PackageInfo,
	resolvePackages,
} from "./package-resolver.ts";

interface WorkspacePackageSelection extends EnumerationOptions {
	childProcess: ChildProcessRunner;
	fileSystem: FileSystem;
}

interface WorkspaceValidationOk {
	ok: true;
}

interface WorkspaceValidationError {
	exitCode: 2;
	message: string;
	ok: false;
}

type WorkspaceValidationResult = WorkspaceValidationError | WorkspaceValidationOk;

const WORKSPACE_ONLY_FLAGS: ReadonlyArray<{
	isPresent: (cli: CliOptions) => boolean;
	name: string;
}> = [
	{ name: "--affected-since", isPresent: (cli) => cli.affectedSince !== undefined },
	{ name: "--packages", isPresent: (cli) => cli.packages !== undefined },
	{ name: "--bail", isPresent: (cli) => cli.bail === true },
];

/** Inputs of {@link resolveWorkspacePackages}. */
export interface ResolveWorkspacePackagesOptions extends WorkspacePackageSelection {
	/** Parsed command-line options. */
	cli: CliOptions;
	/** Absolute workspace root directory. */
	workspaceRoot: string;
}

/**
 * The refusal for a workspace-only flag given without `--workspace`.
 * @param cli - Parsed command-line options.
 * @returns The error message, or `undefined` when the flags are allowed.
 */
export function refuseWorkspaceOnlyFlags(cli: CliOptions): string | undefined {
	if (cli.workspace === true) {
		return undefined;
	}

	const present = WORKSPACE_ONLY_FLAGS.find((flag) => flag.isPresent(cli));
	return present === undefined ? undefined : `Error: ${present.name} requires --workspace.\n`;
}

/**
 * Check the workspace flag combinations.
 * @param cli - Parsed command-line options.
 * @returns Ok, or exit code `2` with the error message.
 */
export function validateBasicWorkspaceFlags(cli: CliOptions): WorkspaceValidationResult {
	if (cli.packages !== undefined && cli.affectedSince !== undefined) {
		return {
			exitCode: 2,
			message: "Error: --packages and --affected-since are mutually exclusive.\n",
			ok: false,
		};
	}

	if (cli.packages !== undefined && !hasNonEmptyPackages(cli.packages)) {
		return { exitCode: 2, message: "Error: --packages names no packages.\n", ok: false };
	}

	return { ok: true };
}

/**
 * Resolve the selected packages.
 * @param options - CLI options, workspace root and enumeration inputs.
 * @param options.childProcess - Runs the change detector.
 * @param options.cli - Parsed command-line options.
 * @param options.exclude - Package globs to exclude.
 * @param options.fileSystem - File system to enumerate.
 * @param options.patterns - Package globs to enumerate.
 * @param options.workspaceRoot - Absolute workspace root directory.
 * @returns The selected packages.
 */
export function resolveWorkspacePackages({
	childProcess,
	cli,
	exclude,
	fileSystem,
	patterns,
	workspaceRoot,
}: ResolveWorkspacePackagesOptions): Array<PackageInfo> {
	if (cli.affectedSince !== undefined) {
		return excludePackages({
			exclude,
			packages: getAffectedPackages({
				childProcess,
				fileSystem,
				ref: cli.affectedSince,
				workspaceRoot,
			}),
			workspaceRoot,
		});
	}

	if (cli.packages === undefined) {
		return enumerateWorkspacePackages(workspaceRoot, { exclude, fileSystem, patterns });
	}

	return resolvePackages({
		fileSystem,
		names: splitPackageNames(cli.packages),
		patterns,
		workspaceRoot,
	});
}

function splitPackageNames(packages: string): Array<string> {
	return packages
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
}

function hasNonEmptyPackages(packages: string): boolean {
	return splitPackageNames(packages).length > 0;
}
