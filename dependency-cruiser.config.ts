import type { IConfiguration, IForbiddenRuleType } from "dependency-cruiser";
import path from "node:path";

import { createDependencyCruiserConfig } from "./dependency-cruiser.shared.ts";

const PROJECT_ROOT = "";
const SOURCE_ROOT = path.posix.join(PROJECT_ROOT, "src");
const TEST_ROOT = path.posix.join(PROJECT_ROOT, "test");
const SOURCE_ROOTS = [
	SOURCE_ROOT,
	...["scripts", "loaders", "bin"].map((root) => path.posix.join(PROJECT_ROOT, root)),
];
const PRODUCTION = `^(?:${SOURCE_ROOTS.map((root) => RegExp.escape(root)).join("|")})/`;
const SOURCE = `^${SOURCE_ROOT}/`;
const NOT_SPEC = "[.]spec(?:-d)?[.]ts$";
const ENTRY_POINTS = `^${SOURCE_ROOT}/(?:cli|index|source)[.]ts$`;
const RUN_ORCHESTRATION = `^${SOURCE_ROOT}/(?:(?:artifacts|run|workspace)/|(?:cli|cli-args|cli-errors|executor|index|output|output-merge|output-report|output-sinks|run|source|workspace-runner|workspace-runner-open)[.]ts$)`;
const ORCHESTRATION = `^${SOURCE_ROOT}/(?:backends|staging)/|${RUN_ORCHESTRATION}`;
const PURE_LAYERS = `^${SOURCE_ROOT}/(?:formatters|highlighter|progress|reporter|results|snapshot|source-mapper|timing|types|utils)/`;
const E2E_ROOT = path.posix.join(TEST_ROOT, "e2e");
const PUBLISHED_INTERFACE = [
	ENTRY_POINTS,
	`^${RegExp.escape(PROJECT_ROOT)}/(?:bin/|loaders/luau-raw[.]mjs$)`,
];
const E2E_PRIVATE_IMPORT_RETROFITS = [
	"live/execution-recovery.spec.ts",
	"live/execution-result.spec.ts",
	"live/result-relay.spec.ts",
	"workspace/synthesizer-rojo-build.spec.ts",
].map((file) => `^${RegExp.escape(path.posix.join(E2E_ROOT, file))}$`);
const ERROR_CLASS_MODULES = ["src/config/errors.ts", "src/reporter/luau-script-error.ts"].map(
	(file) => `^${RegExp.escape(path.posix.join(PROJECT_ROOT, file))}$`,
);

function onlySeamImports(name: string, module: string, seam: string): IForbiddenRuleType {
	return {
		name,
		from: { path: PRODUCTION, pathNot: [`^${RegExp.escape(seam)}$`, NOT_SPEC] },
		severity: "error",
		to: { dependencyTypesNot: ["type-only"], path: module },
	};
}

const ARCHITECTURE_RULES = [
	{
		name: "entry-points-are-not-imported-by-source",
		from: { path: SOURCE, pathNot: NOT_SPEC },
		severity: "error",
		to: { path: ENTRY_POINTS },
	},
	{
		name: "pure-layers-do-not-import-orchestration",
		from: { path: PURE_LAYERS, pathNot: NOT_SPEC },
		severity: "error",
		to: { dependencyTypesNot: ["type-only"], path: ORCHESTRATION },
	},
	{
		name: "utils-import-only-leaf-modules",
		from: { path: `^${SOURCE_ROOT}/utils/`, pathNot: NOT_SPEC },
		severity: "error",
		to: {
			dependencyTypesNot: ["type-only"],
			path: SOURCE,
			pathNot: `^${SOURCE_ROOT}/(?:highlighter|utils)/`,
		},
	},
	{
		name: "backends-do-not-import-run-orchestration",
		from: { path: `^${SOURCE_ROOT}/backends/`, pathNot: NOT_SPEC },
		severity: "error",
		to: { dependencyTypesNot: ["type-only"], path: RUN_ORCHESTRATION },
	},
	{
		name: "coverage-pipeline-does-not-import-orchestration",
		from: { path: `^${SOURCE_ROOT}/coverage-pipeline/`, pathNot: NOT_SPEC },
		severity: "error",
		to: {
			dependencyTypesNot: ["type-only"],
			path: `^${SOURCE_ROOT}/backends/|${RUN_ORCHESTRATION}`,
		},
	},
	{
		name: "e2e-imports-only-package-interface",
		comment:
			"E2E reaches production through the published entries; each retrofit reaches a unit no entry can isolate.",
		from: { path: `^${RegExp.escape(E2E_ROOT)}/`, pathNot: E2E_PRIVATE_IMPORT_RETROFITS },
		severity: "error",
		to: { path: PRODUCTION, pathNot: PUBLISHED_INTERFACE },
	},
	{
		name: "luau-tier-imports-no-production",
		comment:
			"Luau harness specs drive Luau modules in lute; TypeScript production is not theirs.",
		from: { path: `^${RegExp.escape(path.posix.join(TEST_ROOT, "luau"))}/` },
		severity: "error",
		to: { path: PRODUCTION },
	},
	onlySeamImports(
		"only-child-process-seam-spawns",
		"^(?:node:)?child_process$",
		`${SOURCE_ROOT}/utils/child-process.ts`,
	),
	onlySeamImports(
		"only-web-socket-factory-imports-ws",
		"(?:^|/)node_modules/ws/",
		`${SOURCE_ROOT}/backends/web-socket-server-factory.ts`,
	),
] satisfies ReadonlyArray<IForbiddenRuleType>;

const config = createDependencyCruiserConfig({
	ambientModules: [
		"@oxc-project/types",
		"virtual:istanbul-html-assets",
		"virtual:runner-plugin-sources",
	],
	fileSystemSeam: [
		"src/utils/file-system.ts",
		"bin/jest-roblox.js",
		"loaders/istanbul-html-assets.mjs",
		"loaders/luau-raw.mjs",
		"loaders/runner-plugin-sources.mjs",
	].map((seam) => path.posix.join(PROJECT_ROOT, seam)),
	projectRoot: PROJECT_ROOT,
	rules: ARCHITECTURE_RULES,
	sourceRoots: SOURCE_ROOTS,
	testRoot: TEST_ROOT,
	tsConfig: path.join(import.meta.dirname, "tsconfig.json"),
	unitHelperRoots: ["mocks", "setup"].map((root) => path.posix.join(TEST_ROOT, root)),
});

const forbidden: Array<IForbiddenRuleType> = (config.forbidden ?? []).map((rule) => {
	if (rule.name !== "unit-spec-imports-only-sibling" || !("to" in rule)) {
		return rule;
	}

	return {
		...rule,
		comment:
			"Error classes are value-imported by unit specs: instanceof dispatch needs a real instance, and the modules hold no behavior.",
		to: { ...rule.to, pathNot: [rule.to.pathNot ?? [], ERROR_CLASS_MODULES].flat() },
	};
});

const exported: IConfiguration = { ...config, forbidden };

export default exported;
