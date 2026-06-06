// `source`-condition entry for workspace typecheck (tsconfig `customConditions:
// ["source"]`). Mirrors the config + artifact slice of the public API that
// workspace consumers resolve from source — config files import `defineConfig`,
// mutation-tester imports the artifact contract. It deliberately omits the
// CLI/runtime modules in `index.ts` (the dist entry) because those import
// `.luau` assets that only resolve inside this package's own build.
export * from "./config/schema.ts";
export * from "./coverage/artifacts.ts";
