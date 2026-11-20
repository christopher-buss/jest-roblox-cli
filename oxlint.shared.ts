import {
	isentinel,
	type OxlintConfig,
	type OxlintFactoryOptions,
	type OxlintOverride,
	type TypedOxlintConfigItem,
} from "@isentinel/eslint-config/oxlint";

const OXLINT_OVERRIDES: Array<OxlintOverride> = [
	{
		files: ["**/*"],
		rules: {
			"import/consistent-type-specifier-style": "off",
			"oxc/no-map-spread": "off",
			"typescript/no-empty-object-type": ["error", { allowInterfaces: "always" }],
		},
	},
	{
		files: ["**/*.config.ts", "**/*.config.mts", "**/*.shared.ts"],
		rules: {
			"max-lines": "off",
		},
	},
	{
		files: ["**/*.d.ts"],
		rules: {
			"import/no-unassigned-import": [
				"error",
				{ allow: ["@isentinel/dev-vitest-utils/jest-extended", "jest-extended", "vitest"] },
			],
		},
	},
];

export function standaloneOxlint(
	options: OxlintFactoryOptions,
	...userConfigs: Array<TypedOxlintConfigItem>
): OxlintConfig {
	const { options: _rootOnly, ...config } = isentinel(
		{ jsPlugins: false, roblox: false, ...options },
		...userConfigs,
	);

	return {
		...config,
		overrides: [...(config.overrides ?? []), ...OXLINT_OVERRIDES],
	};
}
