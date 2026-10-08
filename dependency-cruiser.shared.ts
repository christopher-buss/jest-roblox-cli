import { type } from "arktype";
import type { IConfiguration, IForbiddenRuleType } from "dependency-cruiser";
import fs from "node:fs";
import path from "node:path";

export interface DependencyCruiserProjectOptions {
	/**
	 * Bare specifiers the type checker declares but no file on disk resolves.
	 */
	ambientModules?: ReadonlyArray<string>;
	/** Shared rules this project opts out of; each is a recorded retrofit. */
	disabledRules?: ReadonlyArray<SharedRuleName>;
	/** The one production file allowed to import `node:fs`. */
	fileSystemSeam?: string;
	projectRoot: string;
	rules: ReadonlyArray<IForbiddenRuleType>;
	sourceRoots: ReadonlyArray<string>;
	testRoot: string;
	tsConfig: string;
}

type SharedRuleOptions = Pick<
	DependencyCruiserProjectOptions,
	"ambientModules" | "projectRoot" | "sourceRoots" | "testRoot"
>;

export type SharedRuleName =
	| "integration-does-not-import-other-suite-helpers"
	| "integration-imports-only-package-interface"
	| "neutral-fixtures-contain-no-production-access"
	| "only-file-system-seam-imports-node-fs"
	| "test-imports-use-package-alias"
	| "unit-helpers-have-no-runtime-production-imports"
	| "unit-specs-do-not-import-integration-helpers"
	| "unit-tier-does-not-import-workspace-helpers"
	| "unit-tier-does-not-touch-real-disk";

const exportSourcesSchema = type({
	"+": "ignore",
	"exports?": {
		"[string]": type("string")
			.pipe((): Array<string> => [])
			.or(
				type({ "+": "ignore", "source": "string" }).pipe(({ source }): Array<string> => {
					return [source];
				}),
			),
	},
});

function readPublishedSourceEntries(projectRoot: string): ReadonlyArray<string> {
	const manifestPath = path.join(import.meta.dirname, projectRoot, "package.json");
	const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	const result = exportSourcesSchema(parsed);
	if (result instanceof type.errors) {
		throw new Error(`Invalid manifest ${manifestPath}: ${result.summary}`);
	}

	return Object.values(result.exports ?? {}).flatMap((sources) => {
		return sources.map((source) => path.posix.join(projectRoot, source));
	});
}

function noProductionCycles(production: string): IForbiddenRuleType {
	return {
		name: "no-production-cycles",
		from: { path: production },
		severity: "error",
		to: {
			circular: true,
			dependencyTypesNot: ["type-only"],
			viaOnly: { dependencyTypesNot: ["type-only"] },
		},
	};
}

function alternation(literals: ReadonlyArray<string>): string {
	return `(?:${literals.map((literal) => RegExp.escape(literal)).join("|")})`;
}

function pathPrefix(...roots: ReadonlyArray<string>): string {
	return `^${alternation(roots)}(?:/|$)`;
}

function createImportRules({
	ambientModules = [],
	projectRoot,
	sourceRoots,
	testRoot,
}: SharedRuleOptions): ReadonlyArray<IForbiddenRuleType> {
	return [
		{
			name: "no-production-to-test",
			from: {
				path: pathPrefix(...sourceRoots),
				pathNot: "[.]spec(?:-d)?[.]ts$",
			},
			severity: "error",
			to: { path: pathPrefix(testRoot) },
		},
		{
			name: "no-unresolvable-project-imports",
			from: {
				path: pathPrefix(projectRoot),
				pathNot: pathPrefix(`${testRoot}/fixtures`),
			},
			severity: "error",
			to: {
				couldNotResolve: true,
				...(ambientModules.length > 0
					? { pathNot: `^${alternation(ambientModules)}$` }
					: {}),
			},
		},
	];
}

function createStructureRules(
	sourceRoots: ReadonlyArray<string>,
): ReadonlyArray<IForbiddenRuleType> {
	const production = pathPrefix(...sourceRoots);
	const spec = `^${alternation(sourceRoots)}/.+[.]spec[.]ts$`;

	return [
		noProductionCycles(production),
		{
			name: "no-cross-spec-imports",
			from: { path: spec },
			severity: "error",
			to: { path: spec },
		},
		{
			name: "unit-spec-imports-only-sibling",
			from: { path: `^(${alternation(sourceRoots)}/.+)[.]spec[.]ts$` },
			severity: "error",
			to: {
				dependencyTypesNot: ["type-only"],
				path: production,
				pathNot: "^$1[.]ts$",
			},
		},
	];
}

type TierRuleOptions = Pick<
	DependencyCruiserProjectOptions,
	"projectRoot" | "sourceRoots" | "testRoot"
> & { fileSystemSeam: string | undefined };

function createTierRules({
	fileSystemSeam,
	projectRoot,
	sourceRoots,
	testRoot,
}: TierRuleOptions): ReadonlyArray<IForbiddenRuleType & { name: SharedRuleName }> {
	const production = pathPrefix(...sourceRoots);
	const unitSpec = `^${alternation(sourceRoots)}/.+[.]spec[.]ts$`;
	const unitHelpers = pathPrefix(`${testRoot}/helpers/unit`);
	const integration = [
		pathPrefix(`${testRoot}/integration`),
		pathPrefix(`${testRoot}/helpers/integration`),
	];
	const publishedEntries = readPublishedSourceEntries(projectRoot);

	return [
		{
			name: "test-imports-use-package-alias",
			comment: "Imports into the test tree use #test so they do not depend on caller depth.",
			from: { path: pathPrefix(projectRoot), pathNot: pathPrefix(`${testRoot}/fixtures`) },
			severity: "error",
			to: {
				dependencyTypes: ["local"],
				dependencyTypesNot: ["aliased-subpath-import"],
				path: pathPrefix(testRoot),
				pathNot: pathPrefix(`${testRoot}/fixtures`),
			},
		},
		{
			name: "unit-helpers-have-no-runtime-production-imports",
			from: { path: unitHelpers },
			severity: "error",
			to: { dependencyTypesNot: ["type-only"], path: production },
		},
		{
			name: "integration-imports-only-package-interface",
			from: { path: integration },
			severity: "error",
			to: {
				path: production,
				...(publishedEntries.length > 0
					? { pathNot: `^${alternation(publishedEntries)}$` }
					: {}),
			},
		},
		{
			name: "unit-specs-do-not-import-integration-helpers",
			from: { path: unitSpec },
			severity: "error",
			to: { path: pathPrefix(`${testRoot}/helpers/integration`) },
		},
		{
			name: "only-file-system-seam-imports-node-fs",
			comment:
				"Production takes a FileSystem; only its disk Adapter file may import node:fs.",
			from: {
				path: production,
				pathNot: [
					...(fileSystemSeam === undefined ? [] : [`^${RegExp.escape(fileSystemSeam)}$`]),
					"[.]spec[.]ts$",
				],
			},
			severity: "error",
			to: { dependencyTypes: ["core"], path: "^(?:node:)?fs(?:/promises)?$" },
		},
		{
			name: "unit-tier-does-not-touch-real-disk",
			comment: "Unit specs seed an in-memory file system; real disk belongs to integration.",
			from: { path: [unitSpec, unitHelpers] },
			severity: "error",
			to: { dependencyTypes: ["core"], path: "^(?:node:)?(?:fs|fs/promises|os)$" },
		},
		{
			name: "integration-does-not-import-other-suite-helpers",
			from: { path: integration },
			severity: "error",
			to: { path: pathPrefix(`${testRoot}/helpers/e2e`, `${testRoot}/helpers/unit`) },
		},
		{
			name: "unit-tier-does-not-import-workspace-helpers",
			comment: "Workspace helpers write to real disk.",
			from: { path: [unitSpec, unitHelpers] },
			severity: "error",
			to: { path: pathPrefix(`${testRoot}/helpers/workspace`) },
		},
		{
			name: "neutral-fixtures-contain-no-production-access",
			from: {
				path: [
					pathPrefix(`${testRoot}/fixtures`),
					`^${RegExp.escape(testRoot)}/helpers/(?!e2e(?:/|$)|integration(?:/|$)|unit(?:/|$))`,
				],
			},
			severity: "error",
			to: { path: production },
		},
	];
}

export function createDependencyCruiserConfig({
	ambientModules = [],
	disabledRules = [],
	fileSystemSeam,
	projectRoot,
	rules,
	sourceRoots,
	testRoot,
	tsConfig,
}: DependencyCruiserProjectOptions): IConfiguration {
	const tierRules = createTierRules({ fileSystemSeam, projectRoot, sourceRoots, testRoot });

	return {
		forbidden: [
			...createImportRules({ ambientModules, projectRoot, sourceRoots, testRoot }),
			...createStructureRules(sourceRoots),
			...tierRules.filter(({ name }) => !disabledRules.includes(name)),
			...rules,
		],
		options: {
			combinedDependencies: false,
			doNotFollow: "node_modules",
			enhancedResolveOptions: {
				conditionNames: ["source", "types", "import", "node", "default"],
				exportsFields: ["exports"],
			},
			tsConfig: { fileName: tsConfig },
			tsPreCompilationDeps: true,
		},
	};
}
