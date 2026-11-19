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

## Run from source

The bin uses the TypeScript source when it is present. Run
`node --conditions=source bin/jest-roblox.js` to also load workspace
dependencies from source. Run `pnpm build:bundle` first: the source imports the
Luau runner and materializer it generates.

A source consumer of `@isentinel/jest-roblox/api` registers the synchronous Node
hooks from `@isentinel/jest-roblox/loader` before it imports the API. The hooks
load raw Luau and the CLI's virtual asset modules.

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

Mutation testing holds the score at 100 alongside the coverage gate. The run is
incremental: `reports/stryker-incremental.json` carries results forward.

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

Remove a clone that `pnpm cpd` finds with a shared helper. Keep a
`// jscpd:ignore-start` / `// jscpd:ignore-end` pair only with a comment that
says why the copy stays.

## Recover missing release binaries

Run the **Release binaries** workflow for an existing release tag:

```bash
gh workflow run release-binaries.yaml --repo christopher-buss/jest-roblox-cli --ref main --field tag=<tag>
```

It builds from that tag and uploads the missing Linux x64, macOS arm64 and
Windows x64 archives. It keeps existing assets, and does not publish to npm or
change the tag.

## Guidelines

- 100% test coverage is enforced. Write tests first. Every PR must maintain full
  coverage.
- Use [conventional commits](https://www.conventionalcommits.org/) for commit
  messages.
