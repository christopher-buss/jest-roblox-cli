/** Where synthesis parks each package's tree, under `ServerStorage`. */
export const STAGE_KEY = "__pkg_stage";

/** The stage entry that holds the mounts several packages share. */
export const SHARED_POOL_NAME = "__shared";

/** Attribute on a marker naming the shared-pool entry it stands for. */
export const SHARED_POOL_ATTRIBUTE = "JestSharedPoolKey";

/**
 * Attribute on a package's stage root when its rojo project declares
 * `emitLegacyScripts: false`.
 */
export const RUN_CONTEXT_ATTRIBUTE = "JestRunContextScripts";

/**
 * Singletons the engine parents only under one service, by that service.
 * Staging demotes them to Folders; the materializer lands their children in
 * the live singleton.
 */
export const NESTED_PINNED_CLASSES: Readonly<Record<string, ReadonlyArray<string>>> = {
	StarterPlayer: ["StarterCharacterScripts", "StarterPlayerScripts"],
	Workspace: ["Terrain"],
};
