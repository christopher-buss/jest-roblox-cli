# Vitest utilities

`@isentinel/dev-vitest-utils` is a package used to share Vitest setup files and
test helpers between the packages in this workspace. It runs on Node >=26 as
ESM, inside Vitest only.

## Use

The package is not published to npm. A package in the same workspace adds it as
a `workspace:*` devDependency. The root `vitest.shared.ts` loads its two setup
files in every project:

- `./setup/jest-extended` adds the jest-extended matchers. `./jest-extended`
  types them; a project imports it from `test/setup/jest-extended.d.ts`.
- `./setup/no-process-start` makes every `node:child_process` starter throw, for
  the unit project only.

The main entry holds an in-memory file system for unit tests:

```ts
import { createMemoryFileSystem } from "@isentinel/dev-vitest-utils";

const { fileSystem, volume } = createMemoryFileSystem({ "/root/a.txt": "alpha" });
```

`createMemoryFileSystem(seed?, cwd?)` returns a memfs volume and a file system
typed as `node:fs`, so any filesystem port accepts it. Relative seed paths
resolve against `cwd`, which defaults to `process.cwd()`.
