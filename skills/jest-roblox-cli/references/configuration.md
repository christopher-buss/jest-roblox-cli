# Configuration

Config file: `jest.config.ts` (also `.js`, `.mjs`). CLI flags override config
file values.

## Key Fields

| Field | Purpose | Default |
|-------|---------|---------|
| `projects` | DataModel paths to search for tests | **(required)** |
| `backend` | `"auto"`, `"open-cloud"`, or `"studio"` | `"auto"` |
| `placeFile` | Path to `.rbxl` file | `"./game.rbxl"` |
| `jestPath` | DataModel path to the Jest module (e.g. `"ReplicatedStorage/Packages/Jest"`) | auto-detect in ReplicatedStorage |
| `timeout` | Max execution time (ms) | `300000` |
| `sourceMap` | Map Luau traces → source | `true` |
| `port` | WebSocket port for Studio backend | `3001` |
| `testMatch` | Glob patterns for test files | `**/*.spec.ts`, `**/*.test.ts`, etc. |
| `testPathPattern` | Regex to filter test files by path | — |
| `testPathIgnorePatterns` | Regex patterns to exclude from discovery | `/node_modules/`, `/dist/` |
| `setupFiles` | DataModel paths to setup scripts (run before env) | — |
| `setupFilesAfterEnv` | DataModel paths to post-env setup scripts | — |
| `rojoProject` | Path to Rojo project file | auto-detected |
| `showLuau` | Show Luau code snippets in failure output | `true` |
| `snapshotFormat` | Snapshot serialization options | — |
| `verbose` | Show individual test results | `false` |
| `compact` | Token-efficient AI-friendly output | `false` |
| `compactMaxFailures` | Max failures shown in compact mode | `10` |
| `gameOutput` | Write game print/warn/error to file | — |
| `cache` | Cache place files by SHA256 hash | `true` |
| `updateSnapshot` | Update snapshot files | — |

## Coverage Fields

| Field | Purpose | Default |
|-------|---------|---------|
| `collectCoverage` | Enable coverage collection | `false` |
| `coverageDirectory` | Output directory | `"coverage"` |
| `coverageReporters` | Istanbul reporter list | `["text", "lcov"]` |
| `coverageThreshold` | Min percentages; fail if not met (branches, functions, lines, statements) | — |
| `coveragePathIgnorePatterns` | Globs to exclude from coverage | test files, node_modules, rbxts_include |
| `collectCoverageFrom` | Globs for files to include in coverage | — |
| `luauRoots` | Compiled Luau directories to instrument | auto from tsconfig `outDir` |

## Type-Check Fields

| Field | Purpose | Default |
|-------|---------|---------|
| `typecheck` | Enable type testing (*.test-d.ts, *.spec-d.ts) | `false` |
| `typecheckOnly` | Run only type tests, skip runtime | `false` |
| `typecheckTsconfig` | Custom tsconfig for type testing | — |

## Example

```typescript
import type { Config } from "@isentinel/jest-roblox";

const config: Config = {
	backend: "open-cloud",
	jestPath: "ReplicatedStorage/Packages/Jest",
	placeFile: "./game.rbxl",
	projects: ["ReplicatedStorage/tests"],
	timeout: 60000,
};

export default config;
```

## Merge Behavior

Configuration is resolved in this order (later wins):

1. Built-in defaults
2. Config file (`jest.config.ts`)
3. CLI flags

All config fields have a corresponding CLI flag. For example, `backend` in
config maps to `--backend` on the CLI.
