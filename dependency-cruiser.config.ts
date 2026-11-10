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
const ENTRY_POINTS = `^${SOURCE_ROOT}/(?:api|cli|index)[.]ts$`;
const RUN_ORCHESTRATION = `^${SOURCE_ROOT}/(?:(?:artifacts|run|workspace)/|executor/executor[.]ts$|(?:api|cli|cli-args|cli-errors|index|run-entry)[.]ts$)`;
const OUTPUT_LAYER = `^${SOURCE_ROOT}/output/`;
const ORCHESTRATION = `^${SOURCE_ROOT}/(?:backends|staging)/|${RUN_ORCHESTRATION}`;
const LAYERS_ABOVE_RESULTS = `${ORCHESTRATION}|${OUTPUT_LAYER}`;
const PURE_LAYERS = `^${SOURCE_ROOT}/(?:formatters|gaps|host-time|progress|jest-output|results|source-mapper|terminal|timing|types|utils)/`;
const E2E_ROOT = path.posix.join(TEST_ROOT, "e2e");
const HARNESS_ROOT = path.posix.join(TEST_ROOT, "harness");
const PUBLISHED_INTERFACE = [
	ENTRY_POINTS,
	`^${RegExp.escape(PROJECT_ROOT)}/(?:bin/|loaders/luau-raw[.]mjs$)`,
];
const E2E_PRIVATE_IMPORT_RETROFITS = ["workspace/synthesizer-rojo-build.spec.ts"].map(
	(file) => `^${RegExp.escape(path.posix.join(E2E_ROOT, file))}$`,
);
const ERROR_CLASS_MODULES = [
	"src/config/errors.ts",
	"src/jest-output/luau-script-error.ts",
	"src/utils/infrastructure-failure.ts",
].map((file) => `^${RegExp.escape(path.posix.join(PROJECT_ROOT, file))}$`);

const PROTOCOL_MODULES = `^${SOURCE_ROOT}/protocol/(?!.*[.]spec[.]ts$)`;
const PURE_VALUE_MODULES = [
	"src/config/resolved-config.ts",
	"src/utils/hash.ts",
	"src/utils/infrastructure-failure.ts",
].map((file) => `^${RegExp.escape(path.posix.join(PROJECT_ROOT, file))}$`);

const RUN_PIPELINE_TYPES = `^${SOURCE_ROOT}/run/(?:pipeline|seams)[.]ts$`;
const RUN_SEAM_MODULES = ["src/run/pipeline.ts", "src/run/seams.ts"].map(
	(file) => `^${RegExp.escape(path.posix.join(PROJECT_ROOT, file))}$`,
);

const CONFIG_SCHEMA_MODULES = ["src/config/config-validation.ts"].map(
	(file) => `^${RegExp.escape(path.posix.join(PROJECT_ROOT, file))}$`,
);
const COVERAGE_MAPPER_MODULES = ["src/coverage-report/mapper.ts"].map(
	(file) => `^${RegExp.escape(path.posix.join(PROJECT_ROOT, file))}$`,
);

const OPTION_REGISTRY_MODULES = ["src/config/options.ts", "src/config/option-row.ts"].map(
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
		comment: "The artifacts entry extends the root entry, so it alone may import it.",
		from: { path: SOURCE, pathNot: [NOT_SPEC, `^${SOURCE_ROOT}/api[.]ts$`] },
		severity: "error",
		to: { path: ENTRY_POINTS },
	},
	{
		name: "pure-layers-do-not-import-orchestration",
		from: { path: PURE_LAYERS, pathNot: NOT_SPEC },
		severity: "error",
		to: { dependencyTypesNot: ["type-only"], path: LAYERS_ABOVE_RESULTS },
	},
	{
		name: "output-does-not-import-orchestration",
		comment: "The run hands output a finished result; output reads nothing of how it ran.",
		from: { path: OUTPUT_LAYER, pathNot: NOT_SPEC },
		severity: "error",
		to: { path: ORCHESTRATION },
	},
	{
		name: "utils-import-only-leaf-modules",
		from: { path: `^${SOURCE_ROOT}/utils/`, pathNot: NOT_SPEC },
		severity: "error",
		to: {
			dependencyTypesNot: ["type-only"],
			path: SOURCE,
			pathNot: `^${SOURCE_ROOT}/(?:protocol|terminal|utils)/`,
		},
	},
	{
		name: "protocol-is-a-leaf",
		from: { path: `^${SOURCE_ROOT}/protocol/`, pathNot: NOT_SPEC },
		severity: "error",
		to: { path: SOURCE, pathNot: `^${SOURCE_ROOT}/protocol/` },
	},
	{
		name: "terminal-is-a-leaf",
		from: { path: `^${SOURCE_ROOT}/terminal/`, pathNot: NOT_SPEC },
		severity: "error",
		to: { path: SOURCE, pathNot: `^${SOURCE_ROOT}/terminal/` },
	},
	{
		name: "backends-do-not-import-run-orchestration",
		from: { path: `^${SOURCE_ROOT}/backends/`, pathNot: NOT_SPEC },
		severity: "error",
		to: { dependencyTypesNot: ["type-only"], path: `${RUN_ORCHESTRATION}|${OUTPUT_LAYER}` },
	},
	{
		name: "coverage-does-not-import-orchestration",
		from: {
			path: `^${SOURCE_ROOT}/(?:attribution|coverage-data|coverage-report|instrument|shadow)/`,
			pathNot: NOT_SPEC,
		},
		severity: "error",
		to: {
			dependencyTypesNot: ["type-only"],
			path: `^${SOURCE_ROOT}/backends/|${RUN_ORCHESTRATION}|${OUTPUT_LAYER}`,
		},
	},
	{
		name: "workspace-layout-does-not-import-run-pipeline",
		comment: "The workspace layout sees the run only through the pipeline's types.",
		from: { path: `^${SOURCE_ROOT}/workspace/`, pathNot: NOT_SPEC },
		severity: "error",
		to: { path: `^${SOURCE_ROOT}/run/`, pathNot: RUN_PIPELINE_TYPES },
	},
	{
		name: "workspace-layout-imports-only-run-pipeline-types",
		from: { path: `^${SOURCE_ROOT}/workspace/`, pathNot: NOT_SPEC },
		severity: "error",
		to: { dependencyTypesNot: ["type-only"], path: RUN_PIPELINE_TYPES },
	},
	{
		name: "e2e-imports-only-package-interface",
		comment:
			"E2E reaches production through the published entries and the wire constants; each retrofit reaches a unit no entry can isolate.",
		from: {
			path: `^(?:${RegExp.escape(E2E_ROOT)}|${RegExp.escape(HARNESS_ROOT)})/`,
			pathNot: E2E_PRIVATE_IMPORT_RETROFITS,
		},
		severity: "error",
		to: { path: PRODUCTION, pathNot: [...PUBLISHED_INTERFACE, PROTOCOL_MODULES] },
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

type PathRule = Extract<IForbiddenRuleType, { to: unknown }>;

function withIntegrationExceptions(rule: PathRule): PathRule {
	return {
		...rule,
		comment:
			"The README option check reads the option registry it documents, and the Luau config type check the schema it mirrors. The coverage report check maps raw hits the way a run does, with no backend to run. The plugin checks read the wire constants the plugin must match.",
		to: {
			...rule.to,
			pathNot: [
				rule.to.pathNot ?? [],
				OPTION_REGISTRY_MODULES,
				CONFIG_SCHEMA_MODULES,
				COVERAGE_MAPPER_MODULES,
				PROTOCOL_MODULES,
			].flat(),
		},
	};
}

function withUnitSpecExceptions(rule: PathRule): PathRule {
	return {
		...rule,
		comment:
			"Error classes are value-imported by unit specs: instanceof dispatch needs a real instance, and the modules hold no behavior. The help spec reads the option registry the help lists. Layout and stage specs drive the real pipeline over the real seams record. Protocol modules hold wire names and constants, so a fake speaks the real wire.",
		to: {
			...rule.to,
			pathNot: [
				rule.to.pathNot ?? [],
				ERROR_CLASS_MODULES,
				OPTION_REGISTRY_MODULES,
				PROTOCOL_MODULES,
				RUN_SEAM_MODULES,
			].flat(),
		},
	};
}

function withPureValueException(rule: PathRule): PathRule {
	return {
		...rule,
		comment:
			"Protocol modules hold wire names and constants, so a fake speaks the real wire. The config defaults and the hash are pure values a fixture would otherwise copy.",
		to: {
			...rule.to,
			pathNot: [rule.to.pathNot ?? [], PROTOCOL_MODULES, PURE_VALUE_MODULES].flat(),
		},
	};
}

const forbidden: Array<IForbiddenRuleType> = (config.forbidden ?? []).map((rule) => {
	if (!("to" in rule)) {
		return rule;
	}

	if (rule.name === "integration-imports-only-package-interface") {
		return withIntegrationExceptions(rule);
	}

	if (rule.name === "unit-helpers-have-no-runtime-production-imports") {
		return withPureValueException(rule);
	}

	return rule.name === "unit-spec-imports-only-sibling" ? withUnitSpecExceptions(rule) : rule;
});

const exported: IConfiguration = { ...config, forbidden };

export default exported;
