# @isentinel/luau-ast

Parse, inspect, edit, print and compile Luau in Node. The official Luau 0.744
parser and compiler run in separate embedded WebAssembly modules. Parsing needs
no subprocess, network connection or runtime asset lookup. The package is ESM.

```ts
import { loadLuauParser, printCst, renameBinding } from "@isentinel/luau-ast";

const parser = loadLuauParser();
const result = parser.parseCst({
	fileName: "example.luau",
	source: "local value = 1\nreturn value\n",
});
if (!result.ok) {
	throw new Error(result.errors.join("\n"));
}

const declaration = result.root.body.body[0];
if (declaration?.type === "Local") {
	const binding = declaration.variables[0]?.node.binding;
	if (binding !== undefined) {
		renameBinding(result.root, { name: "answer", binding });
	}
}

console.log(printCst(result.root));
```

The output is `local answer = 1` followed by `return answer`, retaining both
newlines. An unedited CST prints byte-identical source, including comments and
CRLF line endings. Binding identities distinguish shadowed locals.

## Package interfaces

| Import                         | Interface                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `@isentinel/luau-ast`          | Parser, CST edits and printing, traversal, string decoding, UTF-8 offsets, source indexing and Lute utilities |
| `@isentinel/luau-ast/ast`      | Type-only AST unions, operators and `LuauSpan`                                                                |
| `@isentinel/luau-ast/parser`   | `loadLuauParser`, AST parsing and lossless `parseCst`, snippet construction                                   |
| `@isentinel/luau-ast/cst`      | CST types, kind list, token and node predicates, walkers and token bounds                                     |
| `@isentinel/luau-ast/visit`    | `visitBlock`, `visitStatement`, `visitExpression` and visitor callbacks                                       |
| `@isentinel/luau-ast/compiler` | `loadLuauCompiler`, compilation diagnostics, function resource statistics and optional bytecode text          |

`loadLuauParser()` and `loadLuauCompiler()` initialize synchronously and cache
their default instances separately. Parser imports do not load the compiler.
Parse and compile results discriminate success with `ok`; malformed internal
wrapper output throws. Visitor enter callbacks return `false` to skip children.
The AST visitor does not traverse type annotations.

`createCstEdits()` registers subtree or text replacements and statement
removals. Pass the ledger to `printCst(root, edits)` or
`printCstMapped(root, { edits, source: indexSourceBytes(original) })`.
Conflicting replacements report both callers.
`parser.constructExpression(snippet)` and `parser.constructStatements(snippet)`
produce replacement subtrees. Binding identities inside a snippet belong to that
snippet.

`LuauSpan` uses one-based lines and UTF-8 byte columns, with an exclusive end.
Index a source once with `indexSourceBytes` to slice spans, convert byte ranges
and obtain UTF-16 columns. Printed sourcemap positions use one-based lines and
zero-based UTF-16 columns.

```ts
import { loadLuauCompiler } from "@isentinel/luau-ast/compiler";

const result = loadLuauCompiler().compile(
	"local value = input()\nreturn value",
	{
		bytecodeText: true,
		debugLevel: 2,
		optimizationLevel: 1,
	},
);
if (result.ok) {
	console.log(result.frames, result.bytecodeText);
} else {
	console.error(result.error.message);
}
```

## Prerequisites and checks

Runtime consumers need Node 24.12 or later. Repository development uses the Node
version pinned in `mise.toml` and the workspace pnpm installation. Install the
workspace dependencies before running these commands from packages/luau-ast:

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test-unit
pnpm test-type
pnpm integration
pnpm e2e
pnpm boundaries
pnpm cpd
pnpm knip
pnpm mutation --force
```

Unit specs live beside their runtime module. Integration specs enter through
package interfaces. Type tests sit beside package entry points. `cpd` runs
separate production/helper and spec scans at 40 and 75 tokens respectively;
either scan fails on a clone. `knip` includes a production-only pass, so a spec
cannot justify an otherwise unused export.

Coverage explicitly includes maintained TypeScript runtime files under `src`,
including files no test imports, with 100% statements, branches, functions and
lines. Stryker runs only file-owned unit specs and enforces a 100% mutation
threshold. The shared mutation policy ignores static mutants and
assertion-message mutations. Generated base64 modules and type-only declarations
are outside the measured runtime population.

The mutation command measures the whole population. `--force` disables
incremental verdict reuse.

Architecture checks enforce unit ownership, test-tier isolation, package entry
points, production cycles and filesystem access through the Lute adapter. Local
rules keep tree logic independent of runtime adapters, keep WASM backends below
language APIs and restrict embedded artifacts to their owning backend.

`spawnLute({ scriptPath, args, timeout, maxBuffer })` requires `lute` on `PATH`.
`writeTemporaryLuauScript({ name, source })` writes a process-specific temporary
file; the caller removes it after use. These utilities are independent of the
in-process parser and compiler.

## Rebuilding the embedded modules

Normal builds use the committed modules. Rebuilding them requires `git`, the
pinned Emscripten 6.0.8 `em++` (or `EMXX`) and Luau tag 0.744:

```sh
node wasm/build-wasm.ts
```

The script checks both pins, builds both wrappers and embeds the results. The
script and the wrappers run only on a rebuild, so coverage and mutation do not
measure them. Real-backend integration tests check parser diagnostics, supported
CST kinds and fixture completeness, token ordering, lossless printing, editing,
compiler statistics and fault recovery. They also check that the frozen unit
fixtures match the live parser.

At the pinned Luau version, `(T, ...U) | V` can produce overlapping return-pack
locations. Bracketed attributes on extern-type methods and declaration-context
function types are also unsupported. CST failures include the supplied filename.
