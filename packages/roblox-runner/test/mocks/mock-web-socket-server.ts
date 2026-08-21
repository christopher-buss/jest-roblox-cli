import EventEmitter from "node:events";
import type { AddressInfo } from "node:net";
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

	public address(): Pick<AddressInfo, "port"> {
		return { port: this.port };
	}
}

export function getLastCreatedServer(): MockWebSocketServer | undefined {
	return instances.at(-1);
}
