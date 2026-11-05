import { EventEmitter } from "node:events";
import { vi } from "vitest";

export interface FakeHelperExit {
	code: number;
	stderr?: string;
	stdout?: string;
}

export interface FakeHelperSpawnCall {
	args: Array<string>;
	file: string;
	options: { env: Record<string, string>; stdio: Array<string>; windowsHide: boolean };
}

interface FakeStream extends EventEmitter {
	encoding: string | undefined;
	setEncoding: (encoding: string) => void;
}

export class FakeHelper extends EventEmitter {
	public readonly kill = vi.fn<() => boolean>(() => true);
	public readonly stderr = makeStream();
	public readonly stdout = makeStream();

	public exitCode: null | number = null;
	public signalCode: NodeJS.Signals | null = null;

	public finish({ code, stderr = "", stdout = "" }: FakeHelperExit): void {
		this.stdout.emit("data", stdout);
		this.stderr.emit("data", stderr);
		this.emit("close", code);
	}
}

function makeStream(): FakeStream {
	const stream: FakeStream = Object.assign(new EventEmitter(), {
		encoding: undefined as string | undefined,
		setEncoding: (encoding: string) => {
			stream.encoding = encoding;
		},
	});
	return stream;
}
