describe("failing types", () => {
	it("should reject string as number", () => {
		const x: number = "bad";
		void x;
	});

	it("should pass this one", () => {
		const y: number = 1;
		void y;
	});
});
