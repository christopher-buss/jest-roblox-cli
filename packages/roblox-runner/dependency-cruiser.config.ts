import path from "node:path";

import { createDependencyCruiserConfig } from "../../dependency-cruiser.shared.ts";

const ROOT = "packages/roblox-runner";
const SOURCE = `${ROOT}/src`;
const ADAPTERS = `^${SOURCE}/(?:capacity-submit-client|client-options|cloud-uploads|file-system|memory-store-flush|messaging-publish|open-cloud-fetch|progress-map|sorted-map-inbox|task-reads|work-queue-reader|work-queue-shared|work-queue-writer)[.]ts$`;
const CORE = `^${SOURCE}/(?:credentials|execution-timeout|infrastructure-evidence|place-identity-guard|poll-diagnosis|runner-types|submit-budget|submit-diagnosis|task-envelope|task-quota-error|task-stall-error|task-submit-error)[.]ts$`;
const ORCHESTRATION = `^${SOURCE}/(?:index|memory-store-janitor|ocale-runner|task-pool|task-submission|testing)[.]ts$`;

export default createDependencyCruiserConfig({
	fileSystemSeam: `${SOURCE}/file-system.ts`,
	projectRoot: ROOT,
	rules: [
		{
			name: "adapters-do-not-import-orchestration",
			from: { path: ADAPTERS },
			severity: "error",
			to: { path: ORCHESTRATION },
		},
		{
			name: "core-does-not-import-adapters-or-orchestration",
			from: { path: CORE },
			severity: "error",
			to: {
				dependencyTypesNot: ["type-only"],
				path: `${ADAPTERS}|${ORCHESTRATION}`,
			},
		},
		{
			name: "production-imports-implementation-not-barrel",
			from: { path: `^${SOURCE}/`, pathNot: "[.]spec(?:-d)?[.]ts$" },
			severity: "error",
			to: { path: `^${SOURCE}/index[.]ts$` },
		},
	],
	sourceRoots: [SOURCE],
	testRoot: `${ROOT}/test`,
	tsConfig: path.join(import.meta.dirname, "tsconfig.json"),
});
