/** Represents a roblox tree path. */
export type RbxPath = ReadonlyArray<string>;
/**
 * Named descendants and symbol-valued parent steps, without filesystem
 * separators.
 */
export type RelativeRbxPath = ReadonlyArray<RbxPathParent | string>;

/** A source mount and its corresponding DataModel prefix. */
export interface PartitionInfo {
	/** Filesystem prefix used before appending the unmatched source suffix. */
	fsPath: string;
	/** DataModel prefix as instance names, independent of host separators. */
	rbxPath: RbxPath;
}

// Public API of the vendored @roblox-ts/rojo-resolver fork; consumers
// (roblox-ts) import it by this name, and the value/type pair must share it.
// eslint-disable-next-line flawless/naming-convention -- upstream API name
export const RbxPathParent: unique symbol = Symbol("Parent");
/** Unique parent-step type, distinct from an instance named Parent. */
export type RbxPathParent = typeof RbxPathParent;
