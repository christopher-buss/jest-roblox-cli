# Luau

## Luau configs

A Luau-only project can write its config as `jest.config.luau`. It has the same
fields as every other format and returns them as a table:

```luau
return {
	placeFile = "game.rbxl",
	test = {
		projects = { "ReplicatedStorage/client" },
		testMatch = { "**/*.spec" },
	},
}
```

The CLI reads the file without running it when the returned value holds only
string, number and boolean literals, tables, `::` casts and a
`defineConfig(...)` call. Statements before the `return` are ignored.

A config that holds code (a `require`, a branch, a computed value) runs with
[lute](https://github.com/luau-lang/lute) 1.x. It can return a table or a
function that returns one. `require` resolves from the config's folder. Read the
environment through `@std/process`:

```luau
local process = require("@std/process")
local shared = require("./jest.shared")

return {
	placeFile = if process.env.CI then "ci.rbxl" else "game.rbxl",
	test = { testMatch = shared.testMatch },
}
```

- The CLI runs `JEST_ROBLOX_LUTE_PATH` when it is set, else `lute` on `PATH`.
- The result must convert to JSON. A function value stops the load with an error
  that names the field. Mergeable fields cannot take the function form.
- `extends` can mix formats. An `extends` entry for a Luau base must include the
  `.luau` extension.
- A string in `test.projects` can point at a folder with a project
  `jest.config.luau`, which holds the `test` fields at its top level.

On the `open-cloud` and `studio-cli` backends, Roblox never runs your
`jest.config.luau`. Each folder that holds a project gets a generated config
that holds the evaluated test fields. The attached `studio` backend runs your
own `jest.config.luau` in Roblox, so a config there must hold only Jest fields
that Roblox can run, and must not `require` a module that only lute has.

## Types for Luau configs

Run `jest-roblox setup` in the project root. It writes the type module to
`~/.jest-roblox/typedefs/<version>/` and adds a `jest-roblox` alias:

- If `.config.luau` exists, setup adds the alias to its `luau.aliases` table.
- If only `.luaurc` exists, setup adds the alias to its `aliases`. If the file
  has comments or trailing commas, setup prints the entry for you to add.
- If neither exists, setup creates `.config.luau` with the alias.

Then type your config:

```luau
local jest = require("@jest-roblox/config")

return jest.defineConfig({
	test = {
		testMatch = { "**/*.spec" },
	},
})
```

Run setup again after you upgrade. A run warns when the alias points at the type
folder of another version. CI needs no setup step. To filter to a test file
named `setup`, write `./setup`.

## Luau packages without a Rojo project

A package with no `.project.json`, no `rojoProject` and no `tsconfig.json` gets
a Rojo project built from its folders. The CLI writes it to
`.jest-roblox-layout.project.json` on each run; add that file to `.gitignore`.

- Each top-level folder, except `node_modules` and dot-folders, mounts under
  `ReplicatedStorage/<package folder>`. A string require such as
  `require("../src")` resolves the same in the place as on disk.
- Jest comes from the nearest `node_modules/@rbxts-js.project.json` above the
  package.
- The project sets `Workspace.SignalBehavior` to `Deferred`.

## Luau type tests

Luau type tests are `*.spec-d.luau` or `*.test-d.luau` files beside your runtime
specs. `lute check` checks them on your machine, so `lute` must be on `PATH`.
Turn them on with `test.typecheck.enabled`, `--typecheck` or `--typecheckOnly`.

Each file must start with `--!strict`. A file without it fails.

A `-- @expect-error` comment asserts that the next statement fails type
checking:

```luau
it("rejects a string field", function()
	-- @expect-error
	local _p: Point = {
		x = 1,
		y = "two",
	}
end)
```

- Every type error inside the next statement is expected.
- A directive that matches no error fails with `unused @expect-error`.
- It checks that an error exists. It does not check the message.

## Type assertions

The package ships a Luau module for type assertions. Alias it in your `.luaurc`
(the path is relative to the `.luaurc`):

```json
{
	"languageMode": "strict",
	"aliases": {
		"jest": "node_modules/@isentinel/jest-roblox/lib"
	}
}
```

```luau
--!strict
local t = require("@jest/typecheck")

type GamePass = { name: string, price: number? }

local function getPass(): GamePass
	return { name = "VIP" }
end

t.describe("GamePass", function()
	t.it("is what getPass returns", function()
		t.expectTypeOf(getPass()):toEqualType<<GamePass>>()
	end)
end)
```

- `describe` and `it` do nothing at runtime. They name the tests.
- `expectType<<T>>()` takes a type. `expectTypeOf(value)` takes the type of a
  value.
- `:toEqualType<<U>>()` and `:toEqualTypeOf(value)` assert that the types are
  equal. Use `.never` before them to assert that the types differ (`not` is a
  Luau keyword).
- `:toExtend<<U>>()` asserts that the subject is assignable to `U`. To assert
  the opposite, put `-- @expect-error` above it.

Equality is structural. Order of union members, properties and parameter names
does not matter, and `boolean` equals `true | false`. Read-only and read-write
properties differ, and so do `any` and `unknown`.

A multi-line type literal inside `<<...>>()` is a Luau syntax error. Declare a
type alias first.
