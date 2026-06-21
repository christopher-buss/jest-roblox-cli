declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void): void;

describe("beta typed broken", () => {
	it("should reject a string assigned to number", () => {
		const value: number = "nope";
		void value;
	});
});
