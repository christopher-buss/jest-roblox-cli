-- header comment
--!strict
--[[ block
	comment ]]
--[==[ levelled
block ]] still inside
]==]

local a = 1 -- trailing line comment
local b = 2 --[[ inline block ]] + 3
local	c	=	"tabs"
local d = 4
local trailingSpaces = 6   
local trailingTab = 7	
   
	
	-- indented comment with tab
    -- indented comment with spaces


local e = 5;



-- comment before eof without newline
return a + b + c + d + e --[[ tail ]]