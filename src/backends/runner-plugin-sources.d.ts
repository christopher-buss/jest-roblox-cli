// Built by `loaders/runner-plugin-sources.mjs`.
declare module "virtual:runner-plugin-sources" {
	/** One file, by its path relative to the package root. */
	const runnerPluginSources: ReadonlyArray<{ readonly path: string; readonly text: string }>;
	export default runnerPluginSources;
}
