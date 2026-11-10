import { NESTED_PINNED_CLASSES } from "../protocol/staged-place.ts";

/**
 * Classes the engine parents only at one fixed spot.
 *
 * Both `synthesizer` and `pinned-mounts` consult this set.
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
	"StarterGui",
	"StarterPack",
	"StarterPlayer",
	"Teams",
	"TestService",
	"TextChatService",
	"TweenService",
	"UserInputService",
	"Workspace",
	...Object.values(NESTED_PINNED_CLASSES).flat(),
]);
