import "vitest";

module "vitest" {
	interface ProvidedContext {
		/** Which run `@stryker-mutator/vitest-runner` is driving, if any. */
		mode?: "dry-run" | "mutant";
	}
}
