import { WebSocketServer } from "ws";

export interface WebSocketServerOptions {
	/** Interface to bind. Left out, `ws` listens on every one of them. */
	host?: string | undefined;
	port: number;
}

export type WebSocketServerFactory = (options: WebSocketServerOptions) => WebSocketServer;

export function nodeWebSocketServerFactory(options: WebSocketServerOptions): WebSocketServer {
	return new WebSocketServer(options);
}
