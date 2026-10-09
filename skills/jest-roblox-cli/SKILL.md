---
name: jest-roblox-cli
description: |
  Run Jest tests inside Roblox, configure test execution, collect code
  coverage, and debug test runner failures for Roblox and roblox-ts
  projects. Use when setting up or running tests for a Roblox project,
  executing the jest-roblox command, choosing a backend (studio-cli, Open
  Cloud), editing jest.config.ts, adding test coverage, running a workspace
  of packages, or debugging errors like "Open Cloud credentials are
  required" or "failed to find Jest instance".
---

# jest-roblox CLI

CLI that executes Jest Roblox tests from Node.js. Builds a Roblox place, runs
Luau tests inside Roblox, parses JSON results, and maps stack traces back to
source. Three backends: **studio-cli** (local, self-launched hidden Studio),
**Open Cloud** (remote, uploads the place), and **Studio** (local, attaches to
an open Studio through a plugin).

## Choosing a backend

Run `jest-roblox` with no `--backend` flag. `auto` picks `studio-cli` when
Roblox Studio is installed: a local run that needs no API key, no upload, and no
approval. The CLI prints the pick to stderr
(`Backend: studio-cli (Studio installed)`). Pass `--backend open-cloud` for CI,
when Studio is absent, or when the user asks for it.

Inside an AI agent the default formatter is `agent`; `--verbose` opts out.

## Running Tests

| Task                      | Command                                                   |
| ------------------------- | --------------------------------------------------------- |
| Run all tests             | `jest-roblox`                                             |
| Run specific files        | `jest-roblox src/player.spec.ts src/combat.spec.ts`       |
| Filter by test name       | `jest-roblox -t "should spawn"`                           |
| Filter by file path       | `jest-roblox --testPathPattern player`                    |
| Verbose output            | `jest-roblox --verbose`                                   |
| Update snapshots          | `jest-roblox -u`                                          |
| Type tests only           | `jest-roblox --typecheckOnly`                             |
| Enable type tests         | `jest-roblox --typecheck`                                 |
| Custom tsconfig for types | `jest-roblox --typecheckTsconfig tsconfig.test.json`      |
| JSON output to file       | `jest-roblox --formatters json --outputFile results.json` |
| Every workspace package   | `jest-roblox --workspace`                                 |

**Filtering options**: three ways to narrow what runs:

1. **Positional file args**: pass specific files directly:
   `jest-roblox src/combat/damage.spec.ts`
2. **`--testPathPattern <regex>`**: filter by file path (only matching tests
   execute; the full place is still built)
3. **`-t <regex>`** / **`--testNamePattern`**: filter by test name within
   describe/it blocks

Combine them: `jest-roblox --testPathPattern combat -t "should deal damage"`

Run `jest-roblox --help` for the full flag list. CLI flags override config file
values.

## References

| Topic         | Description                                                        | Reference                                    |
| ------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Backends      | studio-cli, Open Cloud, Studio: requirements, `auto`, VM parallel  | [backends](references/backends.md)           |
| Configuration | jest.config.ts fields, defaults, CLI override behavior             | [configuration](references/configuration.md) |
| Coverage      | Instrumentation pipeline, thresholds, reporters, lute setup        | [coverage](references/coverage.md)           |
| Workspace     | `--workspace` selection, per-package config, coverage, game output | [workspace](references/workspace.md)         |
| Debugging     | Common errors, hints, diagnostic flags                             | [debugging](references/debugging.md)         |

## See Also

For writing tests (describe/it/expect API, matchers, mocking, Luau deviations
from JS Jest), refer to the
[Jest Roblox documentation](https://github.com/Roblox/jest-roblox).
