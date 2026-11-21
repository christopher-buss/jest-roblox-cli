import "vitest";

module "vitest" {
	interface ProvidedContext {
		installedFixtureRoot: string;
		/** Whether `rojo --version` ran in the `e2e` global setup. */
		rojoOnPath: boolean;
	}
}
