local middle = require("./middle")

return function()
	it("should read the leaf through the middle", function()
		expect(middle.value).to.equal(1)
	end)
end
