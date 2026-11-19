# @isentinel/roblox-runner

`@isentinel/roblox-runner` is a package used to run Luau scripts on Roblox
servers from Node, through Open Cloud. It uploads places, submits tasks, reads
their results, and shares work between tasks through MemoryStore.

## Use

The package is not published to npm. jest-roblox-cli bundles it, and packages in
this workspace import it by name. `@isentinel/roblox-runner/testing` holds
helpers for fake task responses.

You need an Open Cloud API key with permission for each operation you use, on
the target universe and place. The place must have Luau Execution enabled.

```ts
import { OcaleRunner, resolveCredentials } from "@isentinel/roblox-runner";

const runner = new OcaleRunner(resolveCredentials());
const { versionNumber } = await runner.uploadPlaceAsync({
	placeFilePath: "./test-place.rbxl",
});
const result = await runner.executeScriptAsync({
	placeVersion: versionNumber,
	script: "return 'hello from Roblox'",
	timeout: 30_000,
});
console.log(result.outputs);
```

`resolveCredentials` reads `ROBLOX_OPEN_CLOUD_API_KEY`, `ROBLOX_UNIVERSE_ID` and
`ROBLOX_PLACE_ID`. Explicit `overrides` win, then variables with the optional
`envPrefix`, then the plain variables, then `defaults`. `defaults` never
supplies an API key.

Open Cloud has no way to cancel a task. A task that has started runs until it
returns or hits its timeout, so a timeout error does not tell you whether the
script ran. Call `readResultAsync` on the error to get a late result, instead of
submitting the task again. To stop a running task early, have it subscribe to a
topic and send a message with `publishMessageAsync`.

See the exported types and their doc comments for the rest of the API.
