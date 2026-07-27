/** Represents a roblox tree path. */
export type RbxPath = ReadonlyArray<string>;
export type RelativeRbxPath = ReadonlyArray<RbxPathParent | string>;

export interface PartitionInfo {
	fsPath: string;
	rbxPath: RbxPath;
}

// Public API of the vendored @roblox-ts/rojo-resolver fork; consumers
// (roblox-ts) import it by this name, and the value/type pair must share it.
// eslint-disable-next-line flawless/naming-convention -- upstream API name
export const RbxPathParent: unique symbol = Symbol("Parent");
export type RbxPathParent = typeof RbxPathParent;
