export const RUNNER_PLUGIN_SOURCES_ID: "virtual:runner-plugin-sources";

/**
 * The source of the module `RUNNER_PLUGIN_SOURCES_ID` stands for: a default
 * export listing the Managed Plugin's Luau files as `{ path, text }`.
 */
export function buildRunnerPluginSourcesModule(): string;
