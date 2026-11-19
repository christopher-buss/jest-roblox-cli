# @isentinel/luau-ast

`@isentinel/luau-ast` is a package used to parse, edit, print and compile Luau
in Node. It embeds the official Luau parser and compiler as WebAssembly, so it
needs no subprocess or network access.

## Use

The package is not published to npm. jest-roblox-cli bundles it, and packages in
this workspace import it by name.

Parse source with `loadLuauParser`. `parseCst` gives a lossless tree: edit it
with `renameBinding` or `createCstEdits`, then print it with `printCst`. An
unedited tree prints the original source byte for byte, comments included.

```ts
import { loadLuauParser, printCst, renameBinding } from "@isentinel/luau-ast";

const result = loadLuauParser().parseCst({
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
// local answer = 1
// return answer
```

Other entry points:

- `@isentinel/luau-ast/compiler`: `loadLuauCompiler` compiles source and reports
  diagnostics, function statistics and bytecode text.
- `@isentinel/luau-ast/visit`: walks an AST.
- `readRequireCall` reads what a `require` call loads, and
  `createStringRequireResolver` finds the file for a require string by Luau's
  require-by-string rules.

Spans (`LuauSpan`) use one-based lines and UTF-8 byte columns. Use
`indexSourceBytes` to convert them to UTF-16 columns. The require resolver has
no built-in prefixes: `@std`, `@lute` and `@rbx` resolve only when a `.luaurc`
or `.config.luau` names them.

The parser does not support `(T, ...U) | V`, or bracketed attributes on extern
type methods and declaration-context function types.

See the exported types and their doc comments for the rest of the API.
