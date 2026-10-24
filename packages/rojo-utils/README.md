# Rojo utilities

`@isentinel/rojo-utils` loads Rojo project trees, expands nested projects, and
maps source files to Roblox DataModel paths. It runs on Node >=24.12 as ESM, not
inside Roblox. roblox-ts, Flamework's transformer and jest-roblox-cli use it.

## Use

The package is not published to npm. Packages in the same workspace depend on it
by name and import its entry point:

```ts
import {
	loadRojoProject,
	mapFsPathToDataModel,
	RojoResolver,
} from "@isentinel/rojo-utils";

const projectPath = "/workspace/game/default.project.json";
const project = loadRojoProject(projectPath);
const instance = mapFsPathToDataModel("out/shared/util.luau", project.tree);

const resolver = RojoResolver.fromPath(projectPath);
const path = resolver.getRbxPathFromFilePath(
	"/workspace/game/out/shared/util.luau",
);
const restored = RojoResolver.fromState(resolver.getState());
```

For a tree containing `ReplicatedStorage: { shared: { $path: "out/shared" } }`,
`instance` is `"ReplicatedStorage/shared/util"` and `path` is
`["ReplicatedStorage", "shared", "util"]`. Resolver snapshots include the walked
project files and directories so a host can invalidate a disk cache.

`loadRojoProject(projectPath, fileSystem?)` validates `name`, `servePort` and
tree metadata, preserves other top-level JSON fields on `raw`, and expands
required nested project mounts. Read and parse failures throw contextual errors
with their original cause. Child values that are not tree objects are skipped.
Optional mounts remain optional, and absolute mounts retain their location
across nested projects.

Other supported entry-point exports include:

- `resolveNestedProjects` and `resolveNestedProjectSources`: expand explicit
  project-file mounts and directories containing `default.project.json`; the
  latter also reports consumed project files. Both take
  `({ rootDirectory, tree }, fileSystem?)` and reject circular project
  references.
- `collectPaths`, `collectRequiredPaths`, `resolveMountPath` and
  `rebaseTreePaths`: inspect or rebase mounts with normalized separators.
- `mapFsRootToDataModel`, `mapFsPathToDataModel`, `findInTree` and
  `matchNodePath`: match mounts with directory boundaries. Lua suffixes and
  trailing `init` are removed by file mapping. Root mapping throws when no mount
  matches; file mapping returns `undefined`.
- `collectMounts({ classify, currentDataModelPath, node })` and
  `pruneAncestors`: select directory mounts through a caller-supplied classifier
  and retain minimal directory prefixes.
- `RojoResolver`, `FileRelation`, `NetworkType`, `RbxType` and `RbxPathParent`:
  a fork of
  [`@roblox-ts/rojo-resolver`](https://github.com/roblox-ts/rojo-resolver) that
  queries script kinds, isolated containers and relative DataModel paths.
  `findRojoConfigFilePath` prefers `default.project.json`; traversal records
  recoverable warnings. `fromTree({ basePath, tree }, fileSystem?)` takes an
  optional filesystem host; `synthetic(basePath)` maps every file below one
  directory, for packages.
- Filename constants, `convertToLuau`, `stripRojoExtensions`, tree predicates,
  and the exported project, mount, filesystem and resolver-state types.

## Development

Development uses the Node version in `mise.toml` and the pnpm version in the
root `package.json`. Run `mise install` and `pnpm install --frozen-lockfile`,
then run these commands from packages/rojo-utils:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test-unit
pnpm test-type
pnpm integration
pnpm boundaries
pnpm cpd
pnpm knip
pnpm mutation --force
```

`test` runs owned unit specs and entry-point type tests with 100% statement,
branch, function and line thresholds. Every maintained runtime module under
`src/` is included, even if unimported; only type declarations and specs are
excluded. Each unit test owns its memory filesystem. Integration tests use the
package entry point with temporary directories and native links. This library
has no process interface or end-to-end tier.

The mutation command measures the whole population. `--force` disables
incremental verdict reuse.

Stryker uses unit tests only and enforces a 100% floor over maintained runtime
TypeScript. The shared Stryker config ignores static mutants and
developer-facing assert messages. No runtime file is excluded by this package.

`cpd-production` scans production and test helpers at 40 tokens; `cpd-spec`
scans runtime and type specs at 75 tokens. `cpd` runs both. `knip` includes a
production-only pass that rejects exports kept alive solely by specs.

Boundaries enforce shared test ownership, tier isolation, package-interface
integration, production cycles and a sole native filesystem adapter. Local rules
keep pure tree/path mapping independent of I/O and orchestration, keep the
walker independent of loader/query layers, and prevent production imports
through the package barrel. The shared project schema earns metadata types at
the input boundary; walkers narrow already-parsed child values.
