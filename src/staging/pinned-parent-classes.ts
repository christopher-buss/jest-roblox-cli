/**
 * Classes the engine refuses to parent anywhere but one fixed spot: every
 * service (DataModel only), plus the nested singletons `StarterPlayerScripts`
 * and `StarterCharacterScripts` (StarterPlayer) and `Terrain` (Workspace).
 *
 * Staging relocates a package's tree under `ServerStorage.__pkg_stage`, so any
 * of them that arrives with its real class sits under the wrong parent there.
 * The engine logs "X must be a child of Y" at place load and strips the node's
 * children before a single test runs. A Folder in the same position keeps the
 * subtree intact: the materializer clones the children into the live service
 * by name and never reads the staged node's class.
 *
 * Two paths bring such a class into the stage, and both consult this set —
 * `synthesizer` for a class the rojo project declares, `pinned-mounts` for one
 * that arrives inside a `$path` mount.
 */
export const PINNED_PARENT_CLASSES: ReadonlySet<string> = new Set([
	"Chat",
	"CollectionService",
	"DataModel",
	"HttpService",
	"Lighting",
	"LocalizationService",
	"MarketplaceService",
	"MaterialService",
	"MessagingService",
	"Players",
	"ReplicatedFirst",
	"ReplicatedStorage",
	"RunService",
	"ServerScriptService",
	"ServerStorage",
	"SoundService",
	"StarterCharacterScripts",
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"StarterPlayerScripts",
	"Teams",
	"Terrain",
	"TestService",
	"TextChatService",
	"TweenService",
	"UserInputService",
	"Workspace",
]);
