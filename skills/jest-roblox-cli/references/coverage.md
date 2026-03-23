# Coverage

Enable with `--coverage`. The pipeline: instruments compiled Luau via
[lute](https://github.com/luau-lang/lute/) → rewrites Rojo project to point at
instrumented shadow copy → builds place → runs tests → collects hit counts →
maps Luau spans back to source via source maps → generates reports.

## Prerequisites

[Lute](https://github.com/luau-lang/lute/) must be installed and on PATH.
Typically installed via `mise` or `rokit`. If you get instrumentation errors,
verify lute is available.

## CLI Flags

| Flag | Purpose | Default |
|------|---------|---------|
| `--coverage` | Enable coverage collection | `false` |
| `--coverageDirectory` | Output directory | `"coverage"` |
| `--coverageReporters` | Reporter list | `text`, `lcov` |
Supported reporters: `clover`, `cobertura`, `html`, `html-spa`, `json`,
`json-summary`, `lcov`, `lcovonly`, `none`, `teamcity`, `text`, `text-lcov`,
`text-summary`.

## Thresholds

Configure in `jest.config.ts` — the run exits non-zero if any metric falls below
its configured value:

```typescript
const config = {
	coverageThreshold: {
		branches: 70,
		functions: 80,
		statements: 80,
	},
};
```

Available metrics: `statements`, `branches`, `functions`, `lines`.

## Config Fields

| Field | Purpose | Default |
|-------|---------|---------|
| `collectCoverage` | Enable coverage (same as `--coverage`) | `false` |
| `coverageDirectory` | Output directory | `"coverage"` |
| `coverageReporters` | Reporter list | `["text", "lcov"]` |
| `coverageThreshold` | Min percentages; fail if not met | — |
| `coveragePathIgnorePatterns` | Globs to exclude from coverage | test files, node_modules, rbxts_include |
| `collectCoverageFrom` | Globs for files to include in coverage | — |
| `luauRoots` | Compiled Luau directories to instrument | auto from tsconfig `outDir` |

## Generated Files

The `.jest-roblox-coverage/` directory holds instrumented Luau files and
manifests. Add it to `.gitignore`:

```gitignore
.jest-roblox-coverage/
coverage/
```

## How It Works

1. Resolves `luauRoots` from tsconfig `outDir` (or explicit config)
2. Copies compiled Luau to shadow directory (`.jest-roblox-coverage/`)
3. Instruments Luau files with coverage probes (`__cov_s`, `__cov_f`, `__cov_b`)
4. Rewrites Rojo project to point at instrumented files
5. Builds coverage place file via `rojo build`
6. Runs tests against the instrumented place
7. Collects hit counts at runtime
8. Maps Luau spans back to source via source maps
9. Generates reports and checks thresholds

Note: `luauRoots` must be a relative path.
