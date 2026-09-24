import type { Backend } from "../../src/backends/interface.ts";

/** The `placeInput` each real backend declares, for fakes built from a kind. */
export const PLACE_INPUT_BY_KIND: Record<Backend["kind"], Backend["placeInput"]> = {
	"open-cloud": "built",
	"studio": "none",
	"studio-cli": "own",
};
