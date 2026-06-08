# Configuration

Config file: `jest.config.ts` (also `.js`, `.mjs`). CLI flags override config
file values.

## Root Fields

Root fields control the CLI/runner. Jest passthrough fields live under `test:`.

| Field | Purpose | Default |
|-------|---------|---------|
| `backend` | `"auto"`, `"open-cloud"`, or `"studio"` | `"auto"` |
| `placeFile` | Path to `.rbxl` file | `"./game.rbxl"` |
| `jestPath` | DataModel path to the Jest module (e.g. `"ReplicatedStorage/Packages/Jest"`) | auto-detect in ReplicatedStorage |
| `timeout` | Max execution time (ms) | `300000` |
| `sourceMap` | Map Luau traces → source | `true` |
| `port` | WebSocket port for Studio backend | `3001` |
| `rojoProject` | Path to Rojo project file | auto-detected |
| `formatters` | Output formatters (`"default"`, `"agent"`, `"json"`, `"github-actions"`) | `["default"]` |
| `gameOutput` | Write game print/warn/error to a file — a path, or `true` for `game-output.log` under the root. In `--workspace` mode, one grouped aggregate file across packages (consensus-resolved) | — |
| `outputFile` | Write the Jest result JSON — a path, or `true` for `jest-output.log` under the root. In `--workspace` mode, the single merged result across packages (consensus-resolved) | — |
| `workspace.gameOutput` | `true` to emit per-package game output under `.jest-roblox/output/` (`--workspace` only) | — |
| `workspace.outputFile` | `true` to emit per-package result files under `.jest-roblox/output/` (`--workspace` only) | — |
| `coverageCache` | Reuse incrementally-instrumented coverage shadow dir between runs | `true` |
| `luauRoots` | Compiled Luau directories to instrument | auto from tsconfig `outDir` |

## Test Fields

Put these under `test: { ... }`.

| Field | Purpose | Default |
|-------|---------|---------|
| `projects` | DataModel paths to search for tests | **(required)** |
| `testMatch` | Glob patterns for test files | `**/*.spec.ts`, `**/*.test.ts`, etc. |
| `testPathPattern` | Regex to filter test files by path | — |
| `testPathIgnorePatterns` | Regex patterns to exclude from discovery | `/node_modules/`, `/dist/` |
| `exclude` | Globs subtracted from Runtime Test discovery (valid at root `test:` and per-project). Applied in single-, multi-project (`projects`), and `--workspace` runs; skipped for explicit positional file args. Type Tests use `typecheck.exclude` | — |
| `setupFiles` | DataModel paths to setup scripts (run before env) | — |
| `setupFilesAfterEnv` | DataModel paths to post-env setup scripts | — |
| `snapshotFormat` | Snapshot serialization options | — |
| `verbose` | Show individual test results | `false` |
| `updateSnapshot` | Update snapshot files | — |

## Coverage Fields

Put these under `test: { ... }`.

| Field | Purpose | Default |
|-------|---------|---------|
| `collectCoverage` | Enable coverage collection | `false` |
| `coverageDirectory` | Output directory | `"coverage"` |
| `coverageReporters` | Istanbul reporter list | `["text", "lcov"]` |
| `coverageThreshold` | Min percentages; fail if not met (branches, functions, lines, statements) | — |
| `coveragePathIgnorePatterns` | Globs to exclude from coverage | test files, node_modules, rbxts_include |
| `collectCoverageFrom` | Globs for files to include in coverage | — |

## Type-Check Fields

Type Tests (`*.spec-d.ts`, `*.test-d.ts`) are configured under
`test: { typecheck: { ... } }`, valid at the root `test:` block and per-project.
Host-only — never forwarded to the Roblox runtime.

| Field | Purpose | Default |
|-------|---------|---------|
| `enabled` | Enable Type Tests (the only gate; setting other fields does not auto-enable) | `false` |
| `only` | Run only Type Tests, skip Runtime Tests | `false` |
| `include` | Globs for Type Test files; when unset, derived from the project's runtime `include` (`.spec.`→`.spec-d.`, `.test.`→`.test-d.`) | derived |
| `exclude` | Globs to exclude from Type Test discovery | — |
| `tsconfig` | Custom tsconfig for type testing (root-only in projects mode) | — |
| `ignoreSourceErrors` | When `false`, type errors in non-test source files surface as source-level failures (vitest parity); `true` reports only errors inside the Type Test files | `false` |
| `spawnTimeout` | Milliseconds a tsgo spawn may run before it is killed and the run throws (per `(tsconfig, cwd)` group) | `10000` |

The type pass runs concurrently with the Roblox runtime run, so the local
CPU-bound tsgo work overlaps the network-bound Open Cloud upload/poll. Multiple
tsconfig groups also run concurrently.

tsgo type-checks the whole tsconfig program; the Type Test globs only select which
files are collected as Type Tests and how diagnostics are attributed.

The `--typecheck`, `--typecheckOnly`, and `--typecheckTsconfig` CLI flags map onto
`enabled`, `only`, and `tsconfig`.

## Example

```typescript
import { defineConfig } from "@isentinel/jest-roblox";

export default defineConfig({
	backend: "open-cloud",
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
2. Config file (`jest.config.ts`)
3. CLI flags

Many config fields have a corresponding CLI flag. For example, `backend` in
config maps to `--backend` on the CLI.
