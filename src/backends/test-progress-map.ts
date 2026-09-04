import { randomUUID } from "node:crypto";

import type { Backend } from "./interface.ts";

/**
 * The SortedMap a run heartbeats which test it reached into, or none.
 *
 * One decision for both dispatch modes, because it is one feature: multi mode
 * and workspace mode reach the backend by different routes, and a predicate
 * written twice is the per-mode fork that goes silently missing from one of
 * them. Open Cloud only — every other backend reports its own failures, so
 * there is nothing a heartbeat would add.
 *
 * @param backend - The backend the run resolved, or none for a run that
 *   dispatches nothing (`--typecheckOnly`).
 * @returns The map id, or undefined when this backend cannot publish one.
 */
export function resolveTestProgressMapId(
	backend: Pick<Backend, "kind"> | undefined,
): string | undefined {
	return backend?.kind === "open-cloud" ? randomUUID() : undefined;
}
