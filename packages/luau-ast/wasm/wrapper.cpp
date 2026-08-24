// Thin WASM wrapper around the official Luau parser, modeled on CLI/src/Ast.cpp.
#include "Luau/Ast.h"
#include "Luau/AstJsonEncoder.h"
#include "Luau/Common.h"
#include "Luau/ParseOptions.h"
#include "Luau/Parser.h"

#include <cstdlib>
#include <cstring>
#include <string>

static bool flagsInitialized = false;

// Force-enable every Luau* bool FFlag, same as upstream's luau-ast CLI
// (CLI/src/Ast.cpp). Deliberate: the AST this module emits stays identical to
// what `luau-ast` at the pinned version prints, so upstream output is always a
// reference to diff against. Parser fixes upstream gates behind flags arrive
// when the pin moves, not when upstream flips a default.
static void initFlags()
{
    if (flagsInitialized)
        return;
    for (Luau::FValue<bool>* flag = Luau::FValue<bool>::list; flag; flag = flag->next)
        if (strncmp(flag->name, "Luau", 4) == 0)
            flag->value = true;
    flagsInitialized = true;
}

extern "C"
{

// Returns a malloc'd NUL-terminated string. On success it is the AST JSON; on
// parse error it starts with "\x01" and carries newline-separated messages.
// Ownership transfers to the caller: free with free_result.
const char* parse_to_json(const char* src, size_t len)
{
    initFlags();

    Luau::Allocator allocator;
    Luau::AstNameTable names(allocator);

    Luau::ParseOptions options;
    options.captureComments = true;
    options.allowDeclarationSyntax = true;

    Luau::ParseResult parseResult = Luau::Parser::parse(src, len, names, allocator, std::move(options));

    std::string out;
    if (!parseResult.errors.empty())
    {
        out.push_back('\x01');
        for (const Luau::ParseError& error : parseResult.errors)
        {
            out += error.getMessage();
            out.push_back('\n');
        }
    }
    else
    {
        out = Luau::toJson(parseResult.root, parseResult.commentLocations);
    }

    char* result = static_cast<char*>(malloc(out.size() + 1));
    memcpy(result, out.data(), out.size());
    result[out.size()] = '\0';
    return result;
}

void free_result(const char* ptr)
{
    free(const_cast<char*>(ptr));
}

} // extern "C"
