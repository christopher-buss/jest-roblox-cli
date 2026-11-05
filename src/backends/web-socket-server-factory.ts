import { WebSocketServer } from "ws";

/** Where a result WebSocket server listens. */
export interface WebSocketServerOptions {
	/** Interface to bind. Left out, `ws` listens on every one of them. */
	host?: string | undefined;
	/** Port to listen on. */
	port: number;
}

/** Creates a WebSocket server; a seam for tests. */
export type WebSocketServerFactory = (options: WebSocketServerOptions) => WebSocketServer;

/**
 * Create a `ws` server.
 *
 * @param options - Host and port to listen on.
 * @returns The listening server.
 */
export function nodeWebSocketServerFactory(options: WebSocketServerOptions): WebSocketServer {
	return new WebSocketServer(options);
}
