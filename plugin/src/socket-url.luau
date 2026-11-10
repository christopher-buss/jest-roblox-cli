--!strict
type Studio = { defaultPort: number, portAttribute: string }

return function(studio: Studio, getAttribute: (name: string) -> any): string
	local port = getAttribute(studio.portAttribute)
	if typeof(port) ~= "number" then
		port = studio.defaultPort
	end

	return "ws://localhost:" .. tostring(port)
end
