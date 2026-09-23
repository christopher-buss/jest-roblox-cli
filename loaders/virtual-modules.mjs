import { buildIstanbulHtmlAssetsModule, ISTANBUL_HTML_ASSETS_ID } from "./istanbul-html-assets.mjs";
import {
	buildRunnerPluginSourcesModule,
	RUNNER_PLUGIN_SOURCES_ID,
} from "./runner-plugin-sources.mjs";

/**
 * Every specifier the source imports that nothing on disk answers, and what
 * builds its module. The two tsdown configs, vitest, and the node hook
 * `bin/jest-roblox.js` registers all serve them from here.
 */
const VIRTUAL_MODULES = {
	[ISTANBUL_HTML_ASSETS_ID]: buildIstanbulHtmlAssetsModule,
	[RUNNER_PLUGIN_SOURCES_ID]: buildRunnerPluginSourcesModule,
};

export function isVirtualModule(id) {
	return Object.hasOwn(VIRTUAL_MODULES, id);
}

export function buildVirtualModule(id) {
	return VIRTUAL_MODULES[id]();
}

/** The same modules as a Rolldown/Vite plugin. */
export function virtualModulesPlugin() {
	return {
		name: "virtual-modules",
		load(id) {
			return isVirtualModule(id) ? buildVirtualModule(id) : undefined;
		},
		resolveId(id) {
			return isVirtualModule(id) ? { id, external: false } : undefined;
		},
	};
}
