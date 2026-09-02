/**
 * What a guarded task returns instead of its own result, followed by `:<booted
 * version>`.
 *
 * Embedded verbatim in a Luau double-quoted string literal, so it must not
 * contain backslashes, double quotes, or newlines. Deliberately outside the
 * `__NAME__` shape callers use for template placeholders, so a later
 * placeholder pass cannot rewrite a guard already baked into a script.
 *
 * Exported for the one question {@link placeVersionGuardSource} cannot answer:
 * whether a script carries a guard for *any* version. Asserting the absence of
 * one particular version's guard passes on a script guarding another.
 */
export const PLACE_VERSION_MISMATCH = "ROBLOX_RUNNER_PLACE_VERSION_MISMATCH";

/** Matches the sentinel and the version the guard appends to it. */
const PLACE_VERSION_MISMATCH_PATTERN = new RegExp(`^${PLACE_VERSION_MISMATCH}:(\\d+)$`);

/**
 * A refusal as the guard writes it. The guard itself builds this in Luau, so
 * nothing in production calls this — it is here so a fake task standing in for
 * a guarded one speaks the format rather than respelling it.
 *
 * @param bootedVersion - The version the task found itself running.
 * @returns The task output a refusing task returns.
 */
export function formatPlaceVersionRefusal(bootedVersion: number): string {
	return `${PLACE_VERSION_MISMATCH}:${String(bootedVersion)}`;
}

/**
 * The guard, as one Luau statement: a task that booted anything other than the
 * version the host published names the version it did boot and returns instead
 * of running, so the host can relaunch that one task pinned. Only the booted
 * version travels — the expected one is baked in here, and Open Cloud exposes
 * nothing else that says which version is head.
 *
 * One statement, so a caller may splice it wherever its own script permits:
 * after a directive header it does not own, or behind a placeholder in a
 * template it authored. Placing it is the caller's job; this module owns only
 * what the guard says.
 *
 * @param expectedPlaceVersion - The version the host published and the task
 *   must be running.
 * @returns Luau source that returns a refusal, or falls through to the rest of
 *   the script.
 */
export function placeVersionGuardSource(expectedPlaceVersion: number): string {
	return (
		`if game.PlaceVersion ~= ${String(expectedPlaceVersion)} then ` +
		`return "${PLACE_VERSION_MISMATCH}:" .. tostring(game.PlaceVersion) end`
	);
}

/**
 * The version a task says it booted, when it refused the place rather than
 * doing its work. Undefined for every other output — including a missing one,
 * which is a lost result rather than a refusal, and including the sentinel on
 * its own, which the guard never emits and only a user script could produce.
 *
 * @param output - The task's first output line.
 * @returns The booted place version, or undefined when this is not a refusal.
 */
export function readRefusedPlaceVersion(output: string | undefined): number | undefined {
	const [, booted] = PLACE_VERSION_MISMATCH_PATTERN.exec(output ?? "") ?? [];
	return booted === undefined ? undefined : Number(booted);
}
