import { isentinel } from "@isentinel/eslint-config";

const SOURCE_FILES = ["src/**/*.ts"];

export default isentinel(
	{
		name: "packages/rojo-utils",
		antiSlop: true,
		jsdoc: true,
		namedConfigs: true,
		naming: true,
		oxlint: "native",
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
			"package-json/restrict-private-properties": "off",
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
	},
	{
		name: "project/src-max-params",
		files: SOURCE_FILES,
		rules: { "better-max-params/better-max-params": ["error", { func: 2 }] },
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
);
