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
vitest run                    # All tests
vitest run src/formatters     # One folder
vitest run src/cli.spec.ts    # One file
```

## Lint

```bash
eslint .
```

## Project structure

```text
jest-roblox-cli/
├── bin/              CLI entry point
├── src/
│   ├── backends/     Open Cloud and Studio backends
│   ├── config/       Config loading and validation
│   ├── coverage/     Coverage instrumentation pipeline
│   ├── formatters/   Output formatters (default, agent, JSON, GitHub Actions)
│   ├── highlighter/  Luau syntax highlighting
│   ├── reporter/     Result parsing and validation
│   ├── source-mapper/ Luau-to-TypeScript error mapping
│   ├── snapshot/     Snapshot file handling
│   ├── typecheck/    Type test runner
│   ├── types/        Shared type definitions
│   └── utils/        Helpers (glob, hash, cache, paths)
├── luau/             Luau code that runs inside Roblox
├── plugin/           Roblox Studio WebSocket plugin
└── test/             Test fixtures and mocks
```

## Guidelines

- 100% test coverage is enforced. Write tests first. Every PR must maintain full coverage.
- Use [conventional commits](https://www.conventionalcommits.org/) for commit messages.
