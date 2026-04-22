local example = require(script.Parent.example)

return function()
	describe("example", function()
		it("should return hello", function()
			expect(example.greet()).to.equal("hello")
		end)
	end)
end
