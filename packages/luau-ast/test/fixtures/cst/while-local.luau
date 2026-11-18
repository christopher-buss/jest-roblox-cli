-- `while local` and `while const` rebind the condition each iteration for the body only.
while local item = queue:pop() do
	print(item)
end

while const  next : number  =  advance()
do
	print(next)
end
