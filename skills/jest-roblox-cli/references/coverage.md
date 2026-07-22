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

| Flag                  | Purpose                                                                                                                      | Default        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `--coverage`          | Enable coverage collection                                                                                                   | `false`        |
| `--no-coverage`       | Disable coverage for this run, overriding `collectCoverage` in config (skips instrumentation, so it runs at plain-run speed) | —              |
| `--coverageDirectory` | Output directory                                                                                                             | `"coverage"`   |
| `--coverageReporters` | Reporter list                                                                                                                | `text`, `lcov` |

Supported reporters: `clover`, `cobertura`, `html`, `html-spa`, `json`,
`json-summary`, `lcov`, `lcovonly`, `none`, `teamcity`, `text`, `text-lcov`,
`text-summary`.

## Agent mode

When run inside an AI coding agent (auto-detected via `std-env` — Claude Code,
Cursor, Codex, …) the default formatter becomes `agent` and the terminal text
reporters trim to minimize tokens:

- `skipFull` hides fully-covered files, so the table lists only what still needs
  tests, with their uncovered line numbers.
- The `flat` summarizer disambiguates same-named files by path suffix
  (`...nt/ui/index.ts`) instead of repeating `index.ts`.
- Fully covered → one line: `Coverage: 100% (N files)`.
- Partially covered → the trimmed table plus a totals line with raw counts:
  `Coverage: 84% stmts (16/19) | 100% branch (4/4) | …`.

File reporters (`lcov`, `json`, …) are unaffected. `--verbose` opts out.

## Thresholds

Configure in `jest.config.ts` — the run exits non-zero if any metric falls below
its configured value:

```typescript
const config = {
	test: {
		coverageThreshold: {
			branches: 70,
			functions: 80,
			statements: 80,
		},
	},
};
```

Available metrics: `statements`, `branches`, `functions`, `lines`.

In `--workspace` mode thresholds are **per-package**: each package that opted
into coverage (its own `collectCoverage`) is gated against its own files. The
workspace-root config's `coverageThreshold` is the metric-level base for every
package; a package's own declaration overrides the metrics it names — even
downward — and unnamed metrics inherit the root's. There is no pooled
cross-package check, so one package's high coverage can't mask another's
shortfall. A package that declares a threshold without `collectCoverage` gets a
warning: the threshold cannot be enforced without instrumentation.

## Config Fields

Put these under `test: { ... }`. Keep `luauRoots` at config root.

| Field                        | Purpose                                | Default                                 |
| ---------------------------- | -------------------------------------- | --------------------------------------- |
| `collectCoverage`            | Enable coverage (same as `--coverage`) | `false`                                 |
| `coverageDirectory`          | Output directory                       | `"coverage"`                            |
| `coverageReporters`          | Reporter list                          | `["text", "lcov"]`                      |
| `coverageThreshold`          | Min percentages; fail if not met       | —                                       |
| `coveragePathIgnorePatterns` | Globs to exclude from coverage         | test files, node_modules, rbxts_include |
| `collectCoverageFrom`        | Globs for files to include in coverage | —                                       |

`coveragePathIgnorePatterns` matches the **TypeScript source path** with
substring semantics (Jest-style), so a file-level glob like `**/index.ts`
excludes barrel files even when they are never required by a test. In workspace
mode each package's own patterns apply to that package's files, so one package
can opt out without affecting another.

`collectCoverageFrom` is **not** scoped per-package in workspace mode — it is
read from the workspace-root config and applied after the cross-package merge,
unlike `coveragePathIgnorePatterns`. Per-package narrowing there comes from each
package's instrumented manifest plus its own ignore patterns.

## Generated Files

The `.jest-roblox/coverage/` directory holds instrumented Luau files and
manifests. Add the umbrella to `.gitignore`:

```gitignore
.jest-roblox/
```

## How It Works

1. Resolves `luauRoots` from tsconfig `outDir` (or explicit config)
2. Copies compiled Luau to shadow directory (`.jest-roblox/coverage/`)
3. Instruments Luau files with coverage probes (`__cov_s`, `__cov_f`, `__cov_b`)
4. Rewrites Rojo project to point at instrumented files
5. Builds coverage place file via `rojo build`
6. Runs tests against the instrumented place
7. Collects hit counts at runtime
8. Maps Luau spans back to source via source maps
9. Generates reports and checks thresholds

Note: `luauRoots` must be a relative path.
