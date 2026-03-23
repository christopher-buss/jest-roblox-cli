---
name: jest-roblox-cli
description:
    Use when running Roblox tests via jest-roblox CLI, configuring jest.config.ts,
    debugging test execution failures, choosing between Open Cloud and Studio
    backends, enabling coverage collection, or filtering which tests to run. Use
    this skill whenever you need to execute tests, diagnose "no backend available"
    or "failed to find Jest instance" errors, set up coverage thresholds, or
    understand how jest-roblox discovers and runs test files. NOT for writing test
    code (describe/it/expect API, matchers, mocking).
---

# jest-roblox CLI

CLI that executes Jest Roblox tests from Node.js. Uploads a Roblox place file,
runs Luau tests inside Roblox, parses JSON results, and maps stack traces back
to source. Two backends: **Open Cloud** (remote via Roblox API) and **Studio**
(local via WebSocket plugin).

Do not assume a specific package manager or TypeScript toolchain when giving
advice — jest-roblox is usable by both roblox-ts and Luau-only projects.

## Running Tests

| Task | Command |
|------|---------|
| Run all tests | `jest-roblox` |
| Run specific files | `jest-roblox src/player.spec.ts src/combat.spec.ts` |
| Filter by test name | `jest-roblox -t "should spawn"` |
| Filter by file path | `jest-roblox --testPathPattern player` |
| Verbose output | `jest-roblox --verbose` |
| Update snapshots | `jest-roblox -u` |
| AI-friendly output | `jest-roblox --compact` |
| Limit compact failures | `jest-roblox --compact --compactMaxFailures 5` |
| Type tests only | `jest-roblox --typecheckOnly` |
| Enable type tests | `jest-roblox --typecheck` |
| Custom tsconfig for types | `jest-roblox --typecheckTsconfig tsconfig.test.json` |
| JSON output to file | `jest-roblox --json --outputFile results.json` |

**Filtering options** — three ways to narrow what runs:

1. **Positional file args** — pass specific files directly: `jest-roblox src/combat/damage.spec.ts`
2. **`--testPathPattern <regex>`** — filter by file path (only matching tests execute; the full place is still uploaded)
3. **`-t <regex>`** / **`--testNamePattern`** — filter by test name within describe/it blocks

Combine them: `jest-roblox --testPathPattern combat -t "should deal damage"`

Run `jest-roblox --help` for the full flag list. CLI flags override config file
values.

## References

| Topic | Description | Reference |
|-------|-------------|-----------|
| Backends | Open Cloud vs Studio, auto-detection, env vars, fallback behavior | [backends](references/backends.md) |
| Configuration | jest.config.ts fields, defaults, CLI override behavior | [configuration](references/configuration.md) |
| Coverage | Instrumentation pipeline, thresholds, reporters, lute setup | [coverage](references/coverage.md) |
| Debugging | Common errors, hints, diagnostic flags | [debugging](references/debugging.md) |

## See Also

For writing tests (describe/it/expect API, matchers, mocking, Luau deviations
from JS Jest), refer to the
[Jest Roblox documentation](https://github.com/Roblox/jest-roblox).
