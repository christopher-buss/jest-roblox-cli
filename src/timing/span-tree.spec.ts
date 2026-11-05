import { describe, expect, it, vi } from "vitest";

import {
	createSpanTree,
	emitFinalReport,
	emitSpanNode,
	formatPhaseStart,
	type SpanNode,
} from "./span-tree.ts";

function makeTree() {
	let now = 0;
	const clock = { now: () => now };
	const opened: Array<[string, boolean]> = [];
	const closed: Array<[string, boolean]> = [];
	const tree = createSpanTree(clock, {
		onSpanClose: (node, isRoot) => {
			closed.push([node.name, isRoot]);
		},
		onSpanOpen: (node, isRoot) => {
			opened.push([node.name, isRoot]);
		},
	});
	return {
		advance: (ms: number) => {
			now += ms;
		},
		closed,
		opened,
		tree,
	};
}

function emit(node: SpanNode): Array<string> {
	const lines: Array<string> = [];
	emitSpanNode(node, (line) => {
		lines.push(line);
	});
	return lines;
}

function makeNode(
	name: string,
	{
		children = [],
		count = 1,
		elapsedMs,
	}: { children?: Array<SpanNode>; count?: number; elapsedMs: number },
): SpanNode {
	return {
		name,
		children: new Map(children.map((child) => [child.name, child])),
		closed: true,
		count,
		elapsedMs,
	};
}

describe(createSpanTree, () => {
	it("should nest spans and report root and child closes", () => {
		expect.assertions(4);

		const { advance, closed, opened, tree } = makeTree();
		const closeOuter = tree.open("outer");
		const closeInner = tree.open("inner");
		advance(5);

		expect(closeInner()).toBe(5);

		advance(3);

		expect(closeOuter()).toBe(8);
		expect(opened).toStrictEqual([
			["outer", true],
			["inner", false],
		]);
		expect(closed).toStrictEqual([
			["inner", false],
			["outer", true],
		]);
	});

	it("should accumulate repeated spans into one node", () => {
		expect.assertions(1);

		const { advance, tree } = makeTree();
		for (const ms of [2, 3]) {
			const close = tree.open("phase");
			advance(ms);
			close();
		}

		expect(tree.roots.get("phase")).toMatchObject({ closed: true, count: 2, elapsedMs: 5 });
	});

	it("should record a leaf under the open frame", () => {
		expect.assertions(2);

		const { tree } = makeTree();
		const close = tree.open("phase");
		tree.record("leaf", 4);
		tree.record("leaf", 1);
		close();
		tree.record("loose", 2);

		expect(tree.roots.get("phase")!.children.get("leaf")).toMatchObject({
			closed: false,
			count: 2,
			elapsedMs: 5,
		});
		expect(tree.roots.get("loose")).toMatchObject({ closed: false, count: 1, elapsedMs: 2 });
	});

	it("should pop the frame when the open callback throws", () => {
		expect.assertions(2);

		const onSpanOpen = vi.fn<(node: SpanNode, isRoot: boolean) => void>();
		onSpanOpen.mockImplementationOnce(() => {
			throw new Error("EPIPE");
		});
		const tree = createSpanTree(
			{ now: () => 0 },
			{ onSpanClose: vi.fn<(node: SpanNode, isRoot: boolean) => void>(), onSpanOpen },
		);

		expect(() => tree.open("broken")).toThrow("EPIPE");

		tree.open("next");

		expect(onSpanOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "next" }), true);
	});
});

describe(emitSpanNode, () => {
	it("should indent children, count repeats, and name the unmeasured gap", () => {
		expect.assertions(1);

		const node = makeNode("phase", {
			children: [
				makeNode("parse", { count: 3, elapsedMs: 6.4 }),
				makeNode("write", { elapsedMs: 2 }),
			],
			elapsedMs: 10,
		});

		expect(emit(node)).toStrictEqual([
			"[TIMING] phase: 10ms",
			"[TIMING]   parse: 6ms (×3)",
			"[TIMING]   write: 2ms",
			"[TIMING]   (unmeasured): 2ms",
		]);
	});

	it("should drop an unmeasured gap below one millisecond or below zero", () => {
		expect.assertions(2);

		const tight = makeNode("tight", {
			children: [makeNode("a", { elapsedMs: 9.6 })],
			elapsedMs: 10,
		});
		const over = makeNode("over", {
			children: [makeNode("a", { elapsedMs: 12 })],
			elapsedMs: 10,
		});

		expect(emit(tight)).toStrictEqual(["[TIMING] tight: 10ms", "[TIMING]   a: 10ms"]);
		expect(emit(over)).toStrictEqual(["[TIMING] over: 10ms", "[TIMING]   a: 12ms"]);
	});

	it("should aggregate repeated nested spans into one counted line", () => {
		expect.assertions(1);

		const node = makeNode("prepareCoverage", {
			children: [makeNode("parse-ast", { count: 2, elapsedMs: 3 })],
			elapsedMs: 10,
		});

		expect(emit(node)).toStrictEqual([
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 3ms (×2)",
			"[TIMING]   (unmeasured): 7ms",
		]);
	});

	it("should report unmeasured time at every depth that has children", () => {
		expect.assertions(1);

		const node = makeNode("runProjects", {
			children: [
				makeNode("processResults", {
					children: [makeNode("buildSourceMapper", { elapsedMs: 1 })],
					elapsedMs: 5,
				}),
			],
			elapsedMs: 20,
		});

		expect(emit(node)).toStrictEqual([
			"[TIMING] runProjects: 20ms",
			"[TIMING]   processResults: 5ms",
			"[TIMING]     buildSourceMapper: 1ms",
			"[TIMING]     (unmeasured): 4ms",
			"[TIMING]   (unmeasured): 15ms",
		]);
	});

	it("should omit the unmeasured line when the children account for the phase", () => {
		expect.assertions(1);

		const node = makeNode("prepareCoverage", {
			children: [makeNode("parse-ast", { elapsedMs: 10 })],
			elapsedMs: 10,
		});

		expect(emit(node)).toStrictEqual([
			"[TIMING] prepareCoverage: 10ms",
			"[TIMING]   parse-ast: 10ms",
		]);
	});

	it("should report a whole millisecond of unmeasured time", () => {
		expect.assertions(1);

		const node = makeNode("prepareCoverage", {
			children: [makeNode("parse-ast", { elapsedMs: 2 })],
			elapsedMs: 3,
		});

		expect(emit(node)).toContain("[TIMING]   (unmeasured): 1ms");
	});
});

describe(emitFinalReport, () => {
	it("should emit unclosed roots and total every root", () => {
		expect.assertions(1);

		const closedRoot = makeNode("phase", { elapsedMs: 10.4 });
		const loose = { ...makeNode("loose", { elapsedMs: 2.6 }), closed: false };
		const lines: Array<string> = [];
		emitFinalReport(
			new Map([
				["loose", loose],
				["phase", closedRoot],
			]),
			(line) => {
				lines.push(line);
			},
		);

		expect(lines).toStrictEqual(["[TIMING] loose: 3ms", "[TIMING] TOTAL (host): 13ms"]);
	});
});

describe(formatPhaseStart, () => {
	it("should announce a phase", () => {
		expect.assertions(1);

		expect(formatPhaseStart("build")).toBe("[TIMING] build: start");
	});
});
