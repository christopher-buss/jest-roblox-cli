import "vitest";

module "vitest" {
	interface ProvidedContext {
		installedFixtureRoot: string;
		/** Which run `@stryker-mutator/vitest-runner` is driving. */
		mode: "dry-run" | "mutant";
		/** Whether `rojo --version` ran in the `e2e` global setup. */
		rojoOnPath: boolean;
	}
}
