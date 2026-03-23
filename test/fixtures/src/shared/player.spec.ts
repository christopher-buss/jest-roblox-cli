import { describe, expect, it } from "@rbxts/jest-globals";

describe("Player", () => {
	it("should have correct name", () => {
		const player = createPlayer("Alice");
		expect(player.name).toBe("Alice");
	});

	it("should never be zero", () => {
		const health = 100;
		expect(health).never.toBe(0);
	});

	it("should track scores", () => {
		const scores: number[] = [];
		[10, 20].forEach((score) => {
			scores.push(score);
			expect(score).toBeGreaterThan(0);
		});
	});

	it("should read optional stats", () => {
		const player = createPlayer("Charlie");
		expect(player.stats?.health).toBe(100);
	});

	it("should match snapshot", () => {
		const player = createPlayer("Dave");
		expect(player).toMatchSnapshot();
	});
});

function createPlayer(name: string) {
	return { name, stats: { health: 100 } };
}
