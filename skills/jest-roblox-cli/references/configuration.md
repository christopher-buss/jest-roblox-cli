# Configuration

Config file: `jest.config.*`, in any format c12 loads (`.ts`, `.js`, `.mjs`,
`.cjs`, `.json`, `.yaml`, `.toml`). A config can inherit a shared base with
`extends: "../jest.shared.ts"`.

## Root Fields

Root fields control the CLI/runner. Jest passthrough fields live under `test:`.

| Field                  | Purpose                                                                                   | Default                          |
| ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- |
| `backend`              | `"auto"`, `"studio-cli"`, `"open-cloud"`, or `"studio"`                                   | `"auto"`                         |
| `placeFile`            | Path to `.rbxl` file                                                                      | `"./game.rbxl"`                  |
| `jestPath`             | DataModel path to the Jest module (e.g. `"ReplicatedStorage/Packages/Jest"`)              | auto-detect in ReplicatedStorage |
| `timeout`              | Max execution time (ms)                                                                   | `300000`                         |
| `sourceMap`            | Map Luau traces → source                                                                  | `true`                           |
| `port`                 | WebSocket port for the attached `studio` backend                                          | `3001`                           |
| `studioPath`           | Roblox Studio executable for `studio-cli` (also `JEST_ROBLOX_STUDIO_PATH`)                | auto-discovered                  |
| `parallel`             | Concurrent Open Cloud sessions, or `"auto"` (= `min(jobs, 3)`)                            | one session                      |
| `rojoProject`          | Path to Rojo project file                                                                 | auto-detected                    |
| `formatters`           | Output formatters (`"default"`, `"agent"`, `"json"`, `"github-actions"`)                  | `["default"]`                    |
| `gameOutput`           | Write game print/warn/error to a file: a path, or `true` for `game-output.log`.           | —                                |
| `outputFile`           | Write the Jest result JSON: a path, or `true` for `jest-output.log`.                      | —                                |
| `workspace.exclude`    | Globs naming package directories an enumerated `--workspace` run must skip                | —                                |
| `workspace.gameOutput` | `true` to emit per-package game output under `.jest-roblox/output/` (`--workspace` only)  | —                                |
| `workspace.outputFile` | `true` to emit per-package result files under `.jest-roblox/output/` (`--workspace` only) | —                                |
| `coverageCache`        | Reuse incrementally-instrumented coverage shadow dir between runs                         | `true`                           |
| `uploadCache`          | Skip the place upload when the place file's bytes are unchanged                           | `true`                           |
| `luauRoots`            | Compiled Luau directories to instrument                                                   | auto from tsconfig `outDir`      |
| `bootProbeTimeout`     | How long the Open Cloud boot probe may take to prove a place version starts (ms)          | `90000`                          |

## Test Fields

Put these under `test: { ... }`.

| Field                    | Purpose                                           | Default                              |
| ------------------------ | ------------------------------------------------- | ------------------------------------ |
| `projects`               | DataModel paths to search for tests               | **(required)**                       |
| `testMatch`              | Glob patterns for test files                      | `**/*.spec.ts`, `**/*.test.ts`, etc. |
| `testPathPattern`        | Regex to filter test files by path                | —                                    |
| `testPathIgnorePatterns` | Regex patterns to exclude from discovery          | `/node_modules/`, `/dist/`           |
| `exclude`                | Globs subtracted from Runtime Test discovery      | —                                    |
| `setupFiles`             | DataModel paths to setup scripts (run before env) | —                                    |
| `setupFilesAfterEnv`     | DataModel paths to post-env setup scripts         | —                                    |
| `snapshotFormat`         | Snapshot serialization options                    | —                                    |
| `verbose`                | Show individual test results                      | `false`                              |
| `updateSnapshot`         | Update snapshot files                             | —                                    |

`exclude` is valid at root `test:` and per-project; it applies in single-,
multi-project (`projects`), and `--workspace` runs, but is skipped for explicit
positional file args. Type Tests use `typecheck.exclude` instead.

## Coverage Fields

Put these under `test: { ... }`.

| Field                        | Purpose                                                                   | Default                                 |
| ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `collectCoverage`            | Enable coverage collection                                                | `false`                                 |
| `coverageDirectory`          | Output directory                                                          | `"coverage"`                            |
| `coverageReporters`          | Istanbul reporter list                                                    | `["text", "lcov"]`                      |
| `coverageThreshold`          | Min percentages; fail if not met (branches, functions, lines, statements) | —                                       |
| `coveragePathIgnorePatterns` | Globs to exclude from coverage                                            | test files, node_modules, rbxts_include |
| `collectCoverageFrom`        | Globs for files to include in coverage                                    | —                                       |

## Type-Check Fields

Type Tests (`*.spec-d.ts`, `*.test-d.ts`) are configured under
`test: { typecheck: { ... } }`, valid at the root `test:` block and per-project.
Host-only — never forwarded to the Roblox runtime.

| Field                | Purpose                                                                                                           | Default |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `enabled`            | Enable Type Tests (the only gate; setting other fields does not auto-enable)                                      | `false` |
| `only`               | Run only Type Tests, skip Runtime Tests                                                                           | `false` |
| `include`            | Globs for Type Test files; when unset, derived from the project's runtime `include` (`.spec.`→`.spec-d.`)         | derived |
| `exclude`            | Globs to exclude from Type Test discovery                                                                         | —       |
| `tsconfig`           | Custom tsconfig for type testing (root-only in projects mode)                                                     | —       |
| `ignoreSourceErrors` | `false`: surface type errors in non-test source files; `true`: report only errors inside Type Test files          | `false` |
| `spawnTimeout`       | Milliseconds to wait for the tsgo process to start before the run throws; bounds startup only, not the type-check | `10000` |

The type pass runs concurrently with the Roblox run, as do multiple tsconfig
groups. The run-level `timeout` bounds the type-check itself.

tsgo type-checks the whole tsconfig program; the Type Test globs only select
which files are collected as Type Tests and how diagnostics are attributed.

The `--typecheck`, `--typecheckOnly`, and `--typecheckTsconfig` CLI flags map
onto `enabled`, `only`, and `tsconfig`.

## Example

```typescript
import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	jestPath: "ReplicatedStorage/Packages/Jest",
	placeFile: "./game.rbxl",
	test: {
		projects: ["ReplicatedStorage/tests"],
	},
	timeout: 60000,
});
```

## Merge Behavior

Configuration is resolved in this order (later wins):

1. Built-in defaults
2. Extended config (`extends`)
3. Config file
4. CLI flags

In `--workspace` mode the root fields resolve per run and the rest per package;
see [workspace](workspace.md).
