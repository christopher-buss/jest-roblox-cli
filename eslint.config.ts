import { isentinel } from "@isentinel/eslint-config";

const SOURCE_FILES = ["src/**/*.ts"];
const MODULE_MOCK_MESSAGE =
	"vi.mock breaks `isolate: false` for the whole unit project. Take the dependency as a parameter instead — see 'Testing patterns' in AGENTS.md.";

export default isentinel(
	{
		name: "tools/jest-roblox-cli",
		antiSlop: false,
		ignores: [
			"**/__fixtures__/**/*",
			"**/fixtures/**/*",
			"**/out-tsc/**/*",
			"docs/**/*",
			".standalone/**/*",
			"plans/**/*",
			"reference/**/*",
			"reports/mutation/**/*",
			"reports/stryker-incremental.json",
			"spike/**/*",
		],
		jsdoc: true,
		namedConfigs: true,
		naming: true,
		oxlint: "native",
		pnpm: false,
		projectStructure: {
			files: SOURCE_FILES,
			ignores: [
				"src/**/*.spec.ts",
				"src/**/*.spec-d.ts",
				"src/**/*.d.ts",
				"src/**/*-types.ts",
			],
			projectRoot: import.meta.dirname,
			structureRoot: "src",
		},
		roblox: false,
		rules: {
			"flawless/no-redundant-type-annotation": "off",
			"flawless/no-shared-mocks": "off",
			"flawless/prefer-mock-throw": "off",
			"flawless/prefer-vitest-local-context": "off",
		},
		test: {
			vitest: {
				extended: true,
				typecheck: true,
			},
		},
		type: "package",
		typescript: {
			parserOptionsTypeAware: {
				projectService: true,
			},
		},
		// Luau AST vocabulary (expr/stmt) is not an abbreviation to expand, and
		// `references/configuration.md` (linked from SKILL.md) must keep its
		// name.
		unicorn: {
			nameReplacements: { configuration: false, expr: false, stmt: false, stmts: false },
		},
	},
	{
		name: "project/src-max-params",
		files: SOURCE_FILES,
		rules: { "better-max-params/better-max-params": ["error", { func: 2 }] },
	},
	{
		name: "project/no-module-mocks",
		files: ["**/*.bench.ts", "**/*.spec.ts", "test/mocks/**/*.ts", "test/setup/**/*.ts"],
		rules: {
			"vitest/no-restricted-vi-methods": [
				"error",
				{ doMock: MODULE_MOCK_MESSAGE, mock: MODULE_MOCK_MESSAGE },
			],
		},
	},
	{
		name: "project/jsdoc",
		files: SOURCE_FILES,
		rules: {
			"jsdoc/require-jsdoc": [
				"error",
				{
					contexts: [
						"TSInterfaceDeclaration",
						"TSTypeAliasDeclaration",
						"TSEnumDeclaration",
						"TSMethodSignature",
						"TSPropertySignature",
					],
					publicOnly: { ancestorsOnly: true },
					require: {
						ArrowFunctionExpression: true,
						ClassDeclaration: true,
						FunctionDeclaration: true,
						FunctionExpression: true,
						MethodDefinition: true,
					},
				},
			],
		},
	},
	{
		name: "project/shared-dependency-cruiser",
		files: ["dependency-cruiser.shared.ts"],
		rules: {
			"flawless/max-lines-per-function": "off",
			"perfectionist/sort-modules": "off",
		},
	},
	{
		name: "project/ambient-declarations",
		files: ["src/luau.d.ts", "src/coverage-pipeline/istanbul-modules.d.ts"],
		rules: {
			"sonar/file-name-differ-from-class": "off",
		},
	},
	{
		name: "project/bin",
		files: ["./bin/**/*"],
		rules: {
			"antfu/no-top-level-await": "off",
		},
	},
);
