import { mergeCliWithConfig } from "./config/merge.ts";
import type { CliOptions, ProjectEntry, ResolvedConfig } from "./config/schema.ts";
import { runMultiProject } from "./run/multi.ts";
import { runSingleProject } from "./run/single.ts";
import type { RunResult } from "./run/types.ts";
import { runWorkspaceMode } from "./run/workspace.ts";

export async function runJestRoblox(cli: CliOptions, config: ResolvedConfig): Promise<RunResult> {
	const merged = mergeCliWithConfig(cli, config);

	if (cli.workspace === true || cli.packages !== undefined || cli.affectedSince !== undefined) {
		return runWorkspaceMode({ cli, config: merged });
	}

	const rawProjects = (merged as unknown as { projects?: Array<ProjectEntry> }).projects;
	if (rawProjects !== undefined && rawProjects.length > 0) {
		return runMultiProject({ cli, config: merged, rawProjects });
	}

	return runSingleProject({ cli, config: merged });
}
