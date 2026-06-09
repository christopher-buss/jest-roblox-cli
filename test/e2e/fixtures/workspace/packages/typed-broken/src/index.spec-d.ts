describe("typed broken", () => {
	it("should reject a string assigned to number", () => {
		const value: number = "nope";
		void value;
	});
});
