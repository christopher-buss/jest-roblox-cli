import EventEmitter from "node:events";
import type { Mock } from "vitest";
import { vi } from "vitest";

const instances: Array<MockWebSocketServer> = [];

export class MockWebSocketServer extends EventEmitter {
	public readonly close: Mock<() => void> = vi.fn();
	public readonly port: number;

	constructor(options: { port: number }) {
		super();
		this.port = options.port;
		instances.push(this);
	}

	public address(): { port: number } {
		return { port: this.port };
	}
}

export function getLastCreatedServer(): MockWebSocketServer | undefined {
	return instances[instances.length - 1];
}
