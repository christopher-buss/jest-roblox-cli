import { type Type, type } from "arktype";

/**
 * One message the game logged during a run, as
 * `luau/game-output-capture.luau` records it.
 */
export interface GameOutputEntry {
	/** The logged text. */
	message: string;
	/** The Roblox `Enum.MessageType` value of the message. */
	messageType: number;
	/** When the game logged the message. */
	timestamp: number;
}

/** Decodes a captured game output list. */
export const gameOutputEntriesSchema: Type<Array<GameOutputEntry>> = type({
	message: "string",
	messageType: "number",
	timestamp: "number",
}).array();
