import "vitest";

module "vitest" {
	interface ProvidedContext {
		/** Which run `@stryker-mutator/vitest-runner` is driving. */
		mode: "dry-run" | "mutant";
	}
}
