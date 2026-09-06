/**
 * The per-test budget every harness spec in this directory declares.
 *
 * These specs assert on Luau, so each one blocks its worker on a synchronous
 * `lute` spawn and its wall time tracks how much of the machine the rest of the
 * workspace holds rather than how much work the harness does. Idle a harness
 * finishes well inside a second; a concurrent `nx affected` running lint,
 * typecheck and another project's suite alongside stretches the same spawn far
 * enough to cross the 5s default, and the whole directory crosses together
 * because they queue behind one another.
 *
 * The number is the one the coverage and source-mapper integration describes
 * already carry, since it buys the same thing: room for a real process to wait
 * its turn. It is a ceiling for a wedged harness, not a target — a spec that
 * approaches it is reporting a genuine regression.
 */
export const LUTE_HARNESS_TIMEOUT = 30_000;
