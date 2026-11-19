# Rojo utilities

`@isentinel/rojo-utils` is a package used to read Rojo project files, and map
source files back to their respective Roblox DataModel paths. It runs in Node.

## Use

The package is not published to npm. jest-roblox-cli bundles it, and packages in
this workspace import it by name.

Load a project with `loadRojoProject`, then pass its `tree` to helpers such as
`mapFsPathToDataModel`. For queries from a file to its DataModel path, use
`RojoResolver`.

```ts
import { loadRojoProject, mapFsPathToDataModel, RojoResolver } from "@isentinel/rojo-utils";

const project = loadRojoProject("/workspace/game/default.project.json");
mapFsPathToDataModel("out/shared/util.luau", project.tree);
// "ReplicatedStorage/shared/util"

const resolver = RojoResolver.fromPath("/workspace/game/default.project.json");
resolver.getRbxPathFromFilePath("/workspace/game/out/shared/util.luau");
// ["ReplicatedStorage", "shared", "util"]
```

`RojoResolver` is a fork of
[`@roblox-ts/rojo-resolver`](https://github.com/roblox-ts/rojo-resolver) and
supports the same queries. See the exported types and their doc comments for the
rest of the API.
