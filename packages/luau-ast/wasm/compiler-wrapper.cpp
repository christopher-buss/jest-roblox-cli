// Thin WASM wrapper around the official Luau compiler. build-wasm.ts adds
// three observation calls to the pinned Compiler.cpp so this wrapper can
// report frame costs without copying the compiler's allocation model.
#include "Luau/Allocator.h"
#include "Luau/Ast.h"
#include "Luau/BytecodeBuilder.h"
#include "Luau/Common.h"
#include "Luau/Compiler.h"
#include "Luau/ExperimentalFlags.h"
#include "Luau/Parser.h"
#include "Luau/ParseResult.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace
{

struct FrameStatistics
{
    Luau::Location location;
    size_t peakLocals = 0;
    unsigned int maxRegisters = 0;
    size_t upvalueCount = 0;
};

std::vector<FrameStatistics> frames;
FrameStatistics* currentFrame = nullptr;
bool flagsInitialized = false;

void initFlags()
{
    if (flagsInitialized)
        return;

    // Match luau-compile's setLuauFlagsDefault rather than the parser
    // wrapper's broader luau-ast flag policy.
    for (Luau::FValue<bool>* flag = Luau::FValue<bool>::list; flag; flag = flag->next)
        if (strncmp(flag->name, "Luau", 4) == 0 && !Luau::isAnalysisFlagExperimental(flag->name))
            flag->value = true;

    flagsInitialized = true;
}

void appendEscaped(std::string& output, const char* value)
{
    output.push_back('"');
    for (const unsigned char character : std::string(value))
    {
        switch (character)
        {
        case '"':
            output += "\\\"";
            break;
        case '\\':
            output += "\\\\";
            break;
        case '\b':
            output += "\\b";
            break;
        case '\f':
            output += "\\f";
            break;
        case '\n':
            output += "\\n";
            break;
        case '\r':
            output += "\\r";
            break;
        case '\t':
            output += "\\t";
            break;
        default:
            if (character < 0x20)
            {
                static const char hex[] = "0123456789abcdef";
                output += "\\u00";
                output.push_back(hex[character >> 4]);
                output.push_back(hex[character & 0x0f]);
            }
            else
                output.push_back(char(character));
        }
    }
    output.push_back('"');
}

void appendLocation(std::string& output, const Luau::Location& location)
{
    output += "{\"beginColumn\":" + std::to_string(location.begin.column + 1);
    output += ",\"beginLine\":" + std::to_string(location.begin.line + 1);
    output += ",\"endColumn\":" + std::to_string(location.end.column + 1);
    output += ",\"endLine\":" + std::to_string(location.end.line + 1) + "}";
}

std::string success()
{
    std::string output = "{\"frames\":[";
    for (size_t frameIndex = 0; frameIndex < frames.size(); ++frameIndex)
    {
        if (frameIndex != 0)
            output.push_back(',');

        const FrameStatistics& frame = frames[frameIndex];
        output += "{\"location\":";
        appendLocation(output, frame.location);
        output += ",\"maxRegisters\":" + std::to_string(frame.maxRegisters);
        output += ",\"peakLocals\":" + std::to_string(frame.peakLocals);
        output += ",\"upvalueCount\":" + std::to_string(frame.upvalueCount) + "}";
    }
    output += "],\"ok\":true}";
    return output;
}

std::string localNameFrom(const char* message)
{
    const std::string_view text(message);
    struct NamedErrorPattern
    {
        std::string_view prefix;
        std::string_view suffix;
    };
    for (const NamedErrorPattern pattern : {
             NamedErrorPattern{"Out of local registers when trying to allocate ", ":"},
             NamedErrorPattern{"Out of upvalue registers when trying to allocate ", ":"},
             NamedErrorPattern{"Local ", " used in the repeat..until condition"},
             NamedErrorPattern{"'", "' refers to a class and cannot be used as a variable name"},
         })
    {
        if (text.compare(0, pattern.prefix.size(), pattern.prefix) == 0)
        {
            const size_t end = text.find(pattern.suffix, pattern.prefix.size());
            return end == std::string_view::npos
                       ? std::string()
                       : std::string(text.substr(pattern.prefix.size(), end - pattern.prefix.size()));
        }
    }

    return {};
}

std::string failure(const char* message, const Luau::Location& location)
{
    std::string output = "{\"error\":{\"message\":";
    appendEscaped(output, message);
    output += ",\"location\":";
    appendLocation(output, location);

    const std::string localName = localNameFrom(message);
    if (!localName.empty())
    {
        output += ",\"localName\":";
        appendEscaped(output, localName.c_str());
    }

    output += "},\"ok\":false}";
    return output;
}

const char* transfer(std::string output)
{
    char* result = static_cast<char*>(malloc(output.size() + 1));
    if (!result)
        return nullptr;
    memcpy(result, output.c_str(), output.size() + 1);
    return result;
}

} // namespace

namespace Luau
{

void recordFrameStart(const Location& location)
{
    frames.push_back({location});
    currentFrame = &frames.back();
}

void recordPeakLocals(size_t localCount)
{
    currentFrame->peakLocals = std::max(currentFrame->peakLocals, localCount);
}

void recordFrameEnd(unsigned int maxRegisters, size_t upvalueCount)
{
    currentFrame->maxRegisters = maxRegisters;
    currentFrame->upvalueCount = upvalueCount;
    currentFrame = nullptr;
}

} // namespace Luau

extern "C"
{

// Returns a malloc'd NUL-terminated JSON result. Ownership transfers to the
// caller, which releases it with free_result.
const char* compile_with_statistics(const char* src, size_t len, int optimizationLevel, int debugLevel)
{
    initFlags();
    frames.clear();
    currentFrame = nullptr;

    Luau::Allocator allocator;
    Luau::AstNameTable names(allocator);
    Luau::ParseResult parseResult = Luau::Parser::parse(src, len, names, allocator);
    if (!parseResult.errors.empty())
    {
        const Luau::ParseError& error = parseResult.errors.front();
        return transfer(failure(error.what(), error.getLocation()));
    }

    Luau::CompileOptions options;
    options.optimizationLevel = optimizationLevel;
    options.debugLevel = debugLevel;

    try
    {
        Luau::BytecodeBuilder bytecode;
        Luau::compileOrThrow(bytecode, parseResult, names, options);
        return transfer(success());
    }
    catch (const Luau::CompileError& error)
    {
        return transfer(failure(error.what(), error.getLocation()));
    }
}

void free_result(const char* ptr)
{
    free(const_cast<char*>(ptr));
}

} // extern "C"
