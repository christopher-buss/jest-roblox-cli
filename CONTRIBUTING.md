# Contributing

## Setup

```bash
pnpm install
```

## Build

```bash
pnpm build         # Full build
pnpm watch         # Watch mode
pnpm typecheck     # Check types
```

## Test

```bash
pnpm test          # Typecheck, then the test suite with coverage
pnpm test-unit     # Unit tests, without coverage
pnpm test-type     # Type tests
pnpm integration   # Integration tests
pnpm test-luau     # Luau harness tests in lute
```

`test-unit` and `integration` build the bundled Luau test runner
(`src/test-runner.bundled.luau`) first, because every spec that imports
`src/runner-payload/test-script.ts` needs it. To run one folder or file, build
it once with `pnpm build:bundle`, then call vitest with a project:

```bash
pnpm vitest run --project unit src/formatters
pnpm vitest run --project unit src/cli.spec.ts
```

## Mutation testing

Stryker mutates `src/`, `loaders/` and the two build scripts, and holds the
mutation score at 100 alongside the coverage gate. The run is incremental:
`reports/stryker-incremental.json` carries results forward, so pass `--force`
after changing the config. The script builds the Luau bundle first, so it works
on a fresh checkout.

```bash
pnpm mutation
```

## Lint and static checks

```bash
pnpm lint          # oxlint, then ESLint
pnpm boundaries    # Import boundaries (dependency-cruiser)
pnpm cpd           # Duplicate code (jscpd), production then specs
pnpm knip          # Unused files, exports and dependencies
```

`pnpm cpd` runs `cpd-production` (source, scripts, loaders, bin and the test
helpers, 40 tokens) and `cpd-spec` (specs, 75 tokens). Remove a clone with a
shared helper. Keep a `// jscpd:ignore-start` / `// jscpd:ignore-end` pair only
with a comment that says why the copy stays.

## Project structure

```text
jest-roblox-cli/
├── bin/              CLI entry point
├── src/
│   ├── backends/     Open Cloud and Studio backends
│   ├── config/       Config loading and validation
│   ├── attribution/  Per-test coverage attribution
│   ├── coverage-data/ Coverage and build manifests, raw coverage, universe
│   ├── coverage-report/ Coverage mapping and istanbul reports
│   ├── formatters/   Output formatters (default, agent, JSON, GitHub Actions)
│   ├── instrument/   Luau probe instrumentation
│   ├── jest-output/  Jest output parsing and validation
│   ├── shadow/       Coverage roots, shadow tree and coverage place
│   ├── source-mapper/ Luau-to-TypeScript error mapping
│   ├── typecheck/    Type test runner
│   ├── types/        Shared type definitions
│   └── utils/        Helpers (glob, hash, cache, paths)
├── luau/             Luau code that runs inside Roblox
├── plugin/           Roblox Studio WebSocket plugin
└── test/             Test fixtures and mocks
```

## Guidelines

- 100% test coverage is enforced. Write tests first. Every PR must maintain full
  coverage.
- Use [conventional commits](https://www.conventionalcommits.org/) for commit
  messages.
