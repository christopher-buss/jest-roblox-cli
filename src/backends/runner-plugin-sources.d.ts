/**
 * The Managed Plugin's source, read out of `plugin/` and `luau/` by whichever
 * loader builds this module — see `loaders/runner-plugin-sources.mjs`.
 */
declare module "virtual:runner-plugin-sources" {
	/** One file, by its path relative to the package root. */
	const runnerPluginSources: ReadonlyArray<{ readonly path: string; readonly text: string }>;
	export default runnerPluginSources;
}
