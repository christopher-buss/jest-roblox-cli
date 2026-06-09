import EventEmitter from "node:events";
import type { Mock } from "vitest";
import { vi } from "vitest";

import type { MockWebSocket } from "./mock-web-socket.ts";

const instances: Array<MockWebSocketServer> = [];

export class MockWebSocketServer extends EventEmitter {
	// Mirrors ws.WebSocketServer client tracking: sockets join on `connection`
	// and leave on `close`, so close() can terminate live plugin sockets.
	public readonly clients = new Set<MockWebSocket>();
	public readonly close: Mock<() => void> = vi.fn();
	public readonly port: number;

	constructor(options: { port: number }) {
		super();
		this.port = options.port;
		instances.push(this);
		this.on("connection", (socket: MockWebSocket) => {
			this.clients.add(socket);
			socket.on("close", () => {
				this.clients.delete(socket);
			});
		});
	}

	public address(): { port: number } {
		return { port: this.port };
	}
}

export function getLastCreatedServer(): MockWebSocketServer | undefined {
	return instances[instances.length - 1];
}
