# jest-roblox-cli

CLI tool that runs Jest tests inside a real Roblox runtime via Open Cloud
(or a local Studio backend) and maps the results back to TypeScript source.

## Language

**Game Output**:
The dump of every line that surfaced in the Roblox Output during a test run —
native `print`/`warn`/`error`, engine warnings, anything `LogService` would
return. Surfaced via the `--gameOutput <path>` flag as a JSON array of
`{ message, messageType, timestamp }` records. Sourced from
`LogService.MessageOut`. Used for human inspection when a test run misbehaves.
_Avoid_: "Jest output", "stdout", "log dump"

**Banner Output**:
The narrower buffer that captures Jest's own writes to its `process.stdout` /
`process.stderr` Writeables via `InterceptWriteable`. Used only by the CLI's
error banner to surface synchronous exit messages (e.g. "No tests found,
exiting with code 1") that would otherwise be eaten by the Promise
rejection unwind. Not exposed as a user-facing flag.
_Avoid_: "captured stdout", "intercepted writes"

## Relationships

- **Game Output** and **Banner Output** are two distinct captures with two
  distinct sinks: one feeds a user-readable file, the other feeds the CLI
  error banner. They are not merged or deduplicated.
- **Banner Output** ⊂ **Game Output** in content (Jest's `process.stdout`
  ultimately calls `print`, which lands in `LogService`), but the two
  captures run independently — Banner Output stays in scope as the
  synchronous, exit-safe path for the error banner.

## Example dialogue

> **Dev:** "My `warn(...)` in a spec doesn't appear in `--gameOutput`."
> **Maintainer:** "**Game Output** dumps `LogService.MessageOut`. If your
> warn isn't there, the LogService capture isn't wired up or the run
> didn't reach the warn. Either way it's not a **Banner Output** issue —
> the banner only shows up on Luau errors."

## Flagged ambiguities

- "Game Output" once meant "whatever the CLI returns as the second output
  slot of the Luau task script". That slot is implementation detail
  (sometimes `[]` placeholder, sometimes a real payload); the term now
  refers exclusively to the LogService-sourced dump regardless of
  transport.
