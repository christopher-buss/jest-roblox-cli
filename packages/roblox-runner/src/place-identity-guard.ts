/**
 * What a guarded task returns instead of its own result when the place it
 * booted is not the one the host published, followed by `:<booted version>`.
 *
 * The booted version is all that travels back. The expected identity is baked
 * into the guard and the host already holds it, so nothing the place could add
 * would tell the host something it did not send — and the version it did boot
 * is what a host relaunches pinned against, and what it diagnoses the mismatch
 * from.
 *
 * Embedded verbatim in a Luau double-quoted string literal, so it must not
 * contain backslashes, double quotes, or newlines. Deliberately outside the
 * `__NAME__` shape callers use for template placeholders, so a later
 * placeholder pass cannot rewrite a guard already baked into a script.
 *
 * Exported for the one question {@link placeIdentityGuardSource} cannot answer:
 * whether a script carries a guard at all. Asserting the absence of one
 * particular guard's text passes on a script guarding something else.
 */
export const PLACE_MISMATCH = "ROBLOX_RUNNER_PLACE_MISMATCH";

/**
 * Instance name the place build stamps its Place Content Id under, a
 * `StringValue` child of {@link PLACE_CONTENT_ID_SERVICE}. Spelled here rather
 * than at the build because this package owns the guard that reads it back: the
 * two spellings are one contract, and only one of them ships inside the place.
 */
export const PLACE_CONTENT_ID_NAME = "__place_content_id";

/** Service the stamp is parented to. See {@link PLACE_CONTENT_ID_NAME}. */
export const PLACE_CONTENT_ID_SERVICE = "ReplicatedStorage";

/** Class the place build writes the stamp as. */
const PLACE_CONTENT_ID_CLASS = "StringValue";

/**
 * What the host knows the place it published by, and therefore what a task on
 * that place is asked to prove.
 *
 * Alternatives rather than fields, because a caller holding a content id has
 * nothing to gain from the version check and a caller without one has nothing
 * else to check. Saying which it holds is what stops a content id lost
 * somewhere upstream from silently buying the weaker guard.
 */
export type ExpectedPlaceIdentity =
	| {
			/** The Place Content Id the place build stamped into the place. */
			contentId: string;
			placeVersion?: undefined;
	  }
	| {
			contentId?: undefined;
			/** The version the publish minted for this run's upload. */
			placeVersion: number;
	  };

/**
 * What a Luau double-quoted literal cannot carry: the quote that would close it
 * early, the escape that would change what follows, and the line breaks that
 * would end the statement.
 */
const UNSAFE_IN_LITERAL_PATTERN = /["\\\n\r]/u;

/** Matches the sentinel and the version the guard appends to it. */
const PLACE_MISMATCH_PATTERN = new RegExp(`^${PLACE_MISMATCH}:([0-9]+)$`);

/**
 * A refusal as the guard writes it. The guard itself builds this in Luau, so
 * nothing in production calls this — it is here so a fake task standing in for
 * a guarded one speaks the format rather than respelling it.
 *
 * @param bootedVersion - The version the task found itself running.
 * @returns The task output a refusing task returns.
 */
export function formatPlaceMismatch(bootedVersion: number): string {
	return `${PLACE_MISMATCH}:${String(bootedVersion)}`;
}

/**
 * The guard, as one Luau statement: a task that booted anything other than the
 * place the host published names the version it did boot and returns instead of
 * running, so the host can relaunch that one task pinned.
 *
 * A stamped place is judged on the stamp alone. The stamp *is* the build, so
 * two places carrying it are interchangeable to a task however their version
 * numbers differ — which is what stops a second checkout of one commit, whose
 * own publish mints its own number, from refusing a place holding exactly the
 * build this run collected. An absent stamp is a mismatch rather than a
 * fallback to the version: every place a stamping run uploads carries one, so a
 * place without it is some other build. The class is checked before `Value` is
 * read, because `FindFirstChild` returns whatever holds the name — reading
 * `Value` off a `Folder` raises, and a task that raises is a lost result the
 * pool relaunches rather than a refusal the host can pin against.
 *
 * Given a version instead, the version is all there is to compare. It proves
 * the place is the object this run's upload made, which is as much as a caller
 * that did not build the place can ask for — and no more, since the same upload
 * of a stale file mints a version too.
 *
 * One statement, so a caller may splice it wherever its own script permits:
 * after a directive header it does not own, or behind a placeholder in a
 * template it authored. Placing it is the caller's job; this module owns only
 * what the guard says.
 *
 * @param expected - The identity the host published and the task must be
 *   running.
 * @returns Luau source that returns a refusal, or falls through to the rest of
 *   the script.
 */
export function placeIdentityGuardSource({
	contentId,
	placeVersion,
}: ExpectedPlaceIdentity): string {
	if (contentId === undefined) {
		return (
			`if game.PlaceVersion ~= ${String(placeVersion)} then ` +
			`return "${PLACE_MISMATCH}:" .. tostring(game.PlaceVersion) end`
		);
	}

	// Refused rather than escaped. Every id this repo mints is a hex digest, so
	// a value that needs escaping is a caller fault rather than a string to
	// repair, and emitting a guard from it would put whatever it carries into a
	// script that runs on the operator's universe.
	if (UNSAFE_IN_LITERAL_PATTERN.test(contentId)) {
		throw new Error(
			`Place Content Id cannot be embedded in the guard: ${JSON.stringify(contentId)} carries a quote, a backslash, or a line break.`,
		);
	}

	return (
		`do local stamp = game:GetService("${PLACE_CONTENT_ID_SERVICE}")` +
		`:FindFirstChild("${PLACE_CONTENT_ID_NAME}") ` +
		`if stamp == nil or not stamp:IsA("${PLACE_CONTENT_ID_CLASS}") ` +
		`or stamp.Value ~= "${contentId}" then ` +
		`return "${PLACE_MISMATCH}:" .. tostring(game.PlaceVersion) end end`
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
	const [, booted] = PLACE_MISMATCH_PATTERN.exec(output ?? "") ?? [];
	return booted === undefined ? undefined : Number(booted);
}
