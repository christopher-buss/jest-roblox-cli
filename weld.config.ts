import { defineConfig } from "@isentinel/weld";

const shared = {
	luauRoot: "luau",
	requireMode: "path",
} satisfies Parameters<typeof defineConfig>[0];

export default defineConfig([
	{
		...shared,
		name: "test-runner",
		entry: "luau/entry.luau",
		output: "src/test-runner.bundled.luau",
	},
	{
		...shared,
		name: "materializer",
		entry: "luau/staging/entry.luau",
		output: "src/materializer.bundled.luau",
	},
]);
