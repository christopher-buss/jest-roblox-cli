import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import type { Backend } from "./backends/interface.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import {
	buildProjectJob,
	executeBackend,
	type ExecuteResult,
	processProjectResult,
} from "./executor.ts";
import { synthesize } from "./staging/synthesizer.ts";
import { generateMaterializerScript } from "./staging/test-script-staged.ts";
import { buildWithRojo } from "./utils/rojo-builder.ts";
import type { PackageInfo } from "./workspace/package-resolver.ts";
import { type PreflightError, validatePackages } from "./workspace/preflight.ts";

const SYNTHESIZED_PROJECT_FILE = "synthesized.project.json";
const SYNTHESIZED_PLACE_FILE = "synthesized.rbxl";
const WORKSPACE_CACHE_DIRECTORY = path.join(".jest-roblox", "workspace");
const ROJO_PROJECT_DEFAULT = "test.project.json";

export interface RunWorkspaceOptions {
	backend: Backend;
	config: ResolvedConfig;
	packageInfo: PackageInfo;
	version: string;
	workspaceRoot: string;
}

export async function runWorkspace(
	options: RunWorkspaceOptions,
): Promise<ExecuteResult | undefined> {
	const { backend, config, packageInfo, version, workspaceRoot } = options;
	const startTime = Date.now();

	const rojoProjectPath = path.resolve(
		packageInfo.packageDirectory,
		config.rojoProject ?? ROJO_PROJECT_DEFAULT,
	);

	const descriptor = {
		name: packageInfo.name,
		packageDirectory: packageInfo.packageDirectory,
		rojoProjectPath,
	};

	const errors = validatePackages([descriptor]);
	if (errors.length > 0) {
		writePreflightErrors(errors);
		return undefined;
	}

	const cacheDirectory = path.join(workspaceRoot, WORKSPACE_CACHE_DIRECTORY);
	fs.mkdirSync(cacheDirectory, { recursive: true });

	const synthProjectPath = path.join(cacheDirectory, SYNTHESIZED_PROJECT_FILE);
	const synthRbxlPath = path.join(cacheDirectory, SYNTHESIZED_PLACE_FILE);

	const projectJson = synthesize({ packages: [descriptor] });
	fs.writeFileSync(synthProjectPath, projectJson);
	buildWithRojo(synthProjectPath, synthRbxlPath);

	const workspaceConfig: ResolvedConfig = {
		...config,
		placeFile: synthRbxlPath,
		rootDir: packageInfo.packageDirectory,
	};

	const job = buildProjectJob({
		config: workspaceConfig,
		displayName: packageInfo.name,
		testFiles: [],
	});

	const script = generateMaterializerScript([
		{ name: packageInfo.name, config: workspaceConfig, testFiles: [] },
	]);

	const { results, timing: backendTiming } = await executeBackend(
		backend,
		[job],
		undefined,
		script,
	);

	// eslint-disable-next-line ts/no-non-null-assertion -- length-1 invariant
	const first = results[0]!;
	return processProjectResult(first, {
		backendTiming,
		config: workspaceConfig,
		startTime,
		version,
	});
}

function writePreflightErrors(errors: Array<PreflightError>): void {
	process.stderr.write("Pre-flight validation failed:\n");
	for (const error of errors) {
		process.stderr.write(`  ${error.package}: ${error.reason}\n`);
	}
}
