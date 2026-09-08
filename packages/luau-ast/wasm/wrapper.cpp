// Thin WASM wrapper around the official Luau parser, modeled on CLI/src/Ast.cpp.
#include "Luau/Ast.h"
#include "Luau/AstJsonEncoder.h"
#include "Luau/Common.h"
#include "Luau/Cst.h"
#include "Luau/ParseOptions.h"
#include "Luau/ParseResult.h"
#include "Luau/Parser.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

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

// Result prefixes shared with src/wasm-runtime.ts: a parse failure carries
// newline-separated messages, a serializer defect carries one message.
static const char PARSE_ERROR_MARKER = '\x01';
static const char DEFECT_MARKER = '\x02';

// One-shot test hook (see inject_cst_fault): the next CST serialization
// closes one container too many, so the writer's own guard fires.
static bool cstFaultArmed = false;

namespace
{

// Position-only concrete syntax tree. Every node is a JSON object whose keys
// sit in lexical order; a token is [beginLine, beginColumn, endLine,
// endColumn], 0-based with UTF-8 byte columns. No token text and no trivia
// cross the boundary: the TypeScript side slices both from the source it
// already holds (src/cst-materialize.ts).
//
// Every token the parser records a position for is written from that
// position. A token it does not record (a `declare` signature's parentheses,
// a type group's opening paren) is found in the source instead: tokens are
// written in lexical order, so the next non-trivia bytes after the last token
// written are that token. Node locations the parser gets wrong or does not
// record are derived from the tokens written between `begin` and `end`.
//
// Every write is guarded. The first failure is recorded and every later write
// is a no-op, so a serializer bug surfaces as a message rather than a trap.
struct CstWriter
{
    std::string out;
    std::vector<bool> needComma;
    const Luau::CstNodeMap& cst;
    std::unordered_map<Luau::AstLocal*, unsigned> bindings;
    std::string failure;
    const char* src;
    size_t len;
    // Byte offset of each line's first byte.
    std::vector<size_t> lineStarts;
    // End of the last token written.
    Luau::Position lastEnd{0, 0};

    CstWriter(const Luau::CstNodeMap& cst, const char* src, size_t len)
        : cst(cst)
        , src(src)
        , len(len)
    {
        lineStarts.reserve(len / 32 + 1);
        lineStarts.push_back(0);
        for (size_t i = 0; i < len; i++)
            if (src[i] == '\n')
                lineStarts.push_back(i + 1);
    }

    bool failed() const
    {
        return !failure.empty();
    }

    void fail(const std::string& message)
    {
        if (!failed())
            failure = message;
    }

    // ---- JSON plumbing ----

    // The root object is the one value written outside a container.
    void sep()
    {
        if (failed())
            return;
        if (needComma.empty())
        {
            if (!out.empty())
                fail("cst writer: second value outside a container");
            return;
        }
        if (needComma.back())
            out.push_back(',');
        needComma.back() = true;
    }

    void close(char delimiter)
    {
        if (failed())
            return;
        if (needComma.empty())
        {
            fail("cst writer: close without a matching open");
            return;
        }
        out.push_back(delimiter);
        needComma.pop_back();
    }

    void open(char delimiter)
    {
        sep();
        if (failed())
            return;
        out.push_back(delimiter);
        needComma.push_back(false);
    }

    void openObj()
    {
        open('{');
    }

    void closeObj()
    {
        close('}');
    }

    void openArr()
    {
        open('[');
    }

    void closeArr()
    {
        close(']');
    }

    void key(const char* name)
    {
        sep();
        if (failed())
            return;
        out.push_back('"');
        out += name;
        out += "\":";
        needComma.back() = false;
    }

    void str(const char* text)
    {
        sep();
        if (failed())
            return;
        out.push_back('"');
        out += text;
        out.push_back('"');
    }

    void num(unsigned value)
    {
        sep();
        if (failed())
            return;
        out += std::to_string(value);
    }

    static bool has(Luau::Position position)
    {
        return position != Luau::Position::missing();
    }

    static Luau::Position after(Luau::Position begin, size_t length)
    {
        return Luau::Position{begin.line, begin.column + unsigned(length)};
    }

    void span(Luau::Position begin, Luau::Position end)
    {
        if (failed())
            return;
        if (end < begin)
        {
            fail("cst writer: inverted span at line " + std::to_string(begin.line + 1));
            return;
        }
        sep();
        out.push_back('[');
        out += std::to_string(begin.line);
        out.push_back(',');
        out += std::to_string(begin.column);
        out.push_back(',');
        out += std::to_string(end.line);
        out.push_back(',');
        out += std::to_string(end.column);
        out.push_back(']');
    }

    void span(Luau::Location location)
    {
        span(location.begin, location.end);
    }

    // ---- source scanning ----

    size_t offsetOf(Luau::Position position)
    {
        if (position.line >= lineStarts.size())
        {
            fail("cst writer: position past the end of the file");
            return len;
        }
        return lineStarts[position.line] + position.column;
    }

    Luau::Position positionOf(size_t offset)
    {
        size_t line = size_t(std::upper_bound(lineStarts.begin(), lineStarts.end(), offset) - lineStarts.begin()) - 1;
        return Luau::Position{unsigned(line), unsigned(offset - lineStarts[line])};
    }

    // The first byte at or after `offset` that is neither whitespace nor
    // part of a comment. The source parsed, so a block comment is closed.
    size_t skipTrivia(size_t offset)
    {
        while (offset < len)
        {
            char c = src[offset];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v')
            {
                offset++;
                continue;
            }
            if (c != '-' || offset + 1 >= len || src[offset + 1] != '-')
                break;
            offset += 2;
            size_t probe = offset;
            if (probe < len && src[probe] == '[')
            {
                probe++;
                size_t level = 0;
                while (probe < len && src[probe] == '=')
                {
                    probe++;
                    level++;
                }
                if (probe < len && src[probe] == '[')
                {
                    offset = closeLongBracket(probe + 1, level);
                    continue;
                }
            }
            while (offset < len && src[offset] != '\n')
                offset++;
        }
        return offset;
    }

    // The byte after the `]=*]` matching a long bracket of `level` equals.
    size_t closeLongBracket(size_t offset, size_t level)
    {
        while (offset < len)
        {
            if (src[offset] != ']')
            {
                offset++;
                continue;
            }
            size_t probe = offset + 1;
            size_t equals = 0;
            while (probe < len && src[probe] == '=')
            {
                probe++;
                equals++;
            }
            if (equals == level && probe < len && src[probe] == ']')
                return probe + 1;
            offset++;
        }
        return len;
    }

    // Where the next token after the last one written starts.
    size_t nextOffset()
    {
        return skipTrivia(offsetOf(lastEnd));
    }

    Luau::Position peek()
    {
        return positionOf(nextOffset());
    }

    char peekByte()
    {
        size_t offset = nextOffset();
        return offset < len ? src[offset] : '\0';
    }

    char byteAt(Luau::Position position)
    {
        size_t offset = offsetOf(position);
        return offset < len ? src[offset] : '\0';
    }

    // Where `text` sits after the last token written; a different next
    // token is a defect.
    Luau::Position find(const char* text)
    {
        size_t offset = nextOffset();
        size_t length = strlen(text);
        if (failed())
            return Luau::Position::missing();
        if (len - offset < length || memcmp(src + offset, text, length) != 0)
        {
            fail(std::string("cst writer: expected '") + text + "' at line " + std::to_string(positionOf(offset).line + 1));
            return Luau::Position::missing();
        }
        return positionOf(offset);
    }

    // ---- tokens ----

    // Every token is written here, so lastEnd tracks the walk.
    void tokenValue(Luau::Position begin, Luau::Position end)
    {
        span(begin, end);
        lastEnd = end;
    }

    void token(const char* name, Luau::Position begin, Luau::Position end)
    {
        key(name);
        tokenValue(begin, end);
    }

    // A token of `length` bytes starting at `begin`, spanning lines if the
    // bytes do.
    void tok(const char* name, Luau::Position begin, size_t length)
    {
        if (failed())
            return;
        if (!has(begin))
        {
            fail(std::string("cst writer: missing position for token '") + name + "'");
            return;
        }
        token(name, begin, positionOf(offsetOf(begin) + length));
    }

    // A keyword or fixed punctuation whose length is the literal's.
    void keyword(const char* name, Luau::Position begin, const char* text)
    {
        tok(name, begin, strlen(text));
    }

    // A token the parser records no position for.
    void seek(const char* name, const char* text)
    {
        Luau::Position begin = find(text);
        if (has(begin))
            keyword(name, begin, text);
    }

    // A keyword or punctuation the parser records a position for on some
    // paths only.
    void keywordAt(const char* name, Luau::Position begin, const char* text)
    {
        if (has(begin))
            keyword(name, begin, text);
        else
            seek(name, text);
    }

    void tokLoc(const char* name, Luau::Location location)
    {
        token(name, location.begin, location.end);
    }

    // A closing delimiter: `length` bytes ending where `location` ends.
    void tokEnd(const char* name, Luau::Location location, size_t length)
    {
        if (failed())
            return;
        if (location.end.column < length)
        {
            fail(std::string("cst writer: closing token '") + name + "' underflows its line");
            return;
        }
        token(name, Luau::Position{location.end.line, location.end.column - unsigned(length)}, location.end);
    }

    // CST data the parser attaches on some paths only.
    template<typename T>
    T* tryCstOf(Luau::AstNode* node)
    {
        Luau::CstNode* const* found = cst.find(node);
        return found ? (*found)->as<T>() : nullptr;
    }

    template<typename T>
    T* cstOf(Luau::AstNode* node, const char* kind)
    {
        T* data = tryCstOf<T>(node);
        if (!data)
            fail(std::string("cst writer: missing CST data for ") + kind + " at line " + std::to_string(node->location.begin.line + 1));
        return data;
    }

    // ---- nodes ----

    void begin(const char* type, Luau::Location location)
    {
        openObj();
        key("type");
        str(type);
        key("location");
        span(location);
    }

    // A node whose location is derived from its tokens: it starts at the
    // next token and `end` closes it after the last one written.
    Luau::Position begin(const char* type)
    {
        openObj();
        key("type");
        str(type);
        return peek();
    }

    void end(Luau::Position start)
    {
        key("location");
        span(start, lastEnd);
        closeObj();
    }

    unsigned binding(Luau::AstLocal* local)
    {
        auto found = bindings.find(local);
        if (found != bindings.end())
            return found->second;
        unsigned id = unsigned(bindings.size()) + 1;
        bindings[local] = id;
        return id;
    }

    // A name that resolves to a local carries its binding; any other name is
    // a global.
    void nameRef(Luau::AstLocal* local, const char* name, Luau::Position position)
    {
        Luau::Location location{position, after(position, strlen(name))};
        if (local)
        {
            begin("LocalRef", location);
            key("binding");
            num(binding(local));
        }
        else
            begin("Global", location);
        tokLoc("name", location);
        closeObj();
    }

    // ---- types ----

    void type(Luau::AstType* node)
    {
        if (failed())
            return;
        if (auto n = node->as<Luau::AstTypeReference>())
            typeReference(n);
        else if (auto n = node->as<Luau::AstTypeTable>())
            typeTable(n);
        else if (auto n = node->as<Luau::AstTypeFunction>())
            typeFunction(n);
        else if (auto n = node->as<Luau::AstTypeTypeof>())
        {
            Luau::CstTypeTypeof* data = cstOf<Luau::CstTypeTypeof>(n, "typeof");
            if (!data)
                return;
            Luau::Position start = begin("TypeTypeof");
            keyword("keyword", n->location.begin, "typeof");
            keywordAt("open", data->openPosition, "(");
            key("expr");
            expr(n->expr);
            keywordAt("close", data->closePosition, ")");
            end(start);
        }
        else if (auto n = node->as<Luau::AstTypeOptional>())
        {
            Luau::Position start = begin("TypeOptional");
            tokLoc("token", n->location);
            end(start);
        }
        else if (auto n = node->as<Luau::AstTypeUnion>())
        {
            if (auto data = cstOf<Luau::CstTypeUnion>(n, "union"))
            {
                Luau::Position start = begin("TypeUnion");
                composite(start, n->types, data->leadingPosition, data->separatorPositions);
            }
        }
        else if (auto n = node->as<Luau::AstTypeIntersection>())
        {
            if (auto data = cstOf<Luau::CstTypeIntersection>(n, "intersection"))
            {
                Luau::Position start = begin("TypeIntersection");
                composite(start, n->types, data->leadingPosition, data->separatorPositions);
            }
        }
        else if (auto n = node->as<Luau::AstTypeSingletonBool>())
        {
            Luau::Position start = begin("TypeSingletonBool");
            tokLoc("token", n->location);
            end(start);
        }
        else if (auto n = node->as<Luau::AstTypeSingletonString>())
        {
            Luau::Position start = begin("TypeSingletonString");
            tokLoc("token", n->location);
            end(start);
        }
        else if (auto n = node->as<Luau::AstTypeGroup>())
        {
            Luau::CstTypeGroup* data = cstOf<Luau::CstTypeGroup>(n, "type group");
            if (!data)
                return;
            // The parser records the closing paren only; a group folded out
            // of a type argument's `(T)` even takes the inner type's span.
            Luau::Position start = begin("TypeGroup");
            seek("open", "(");
            key("inner");
            type(n->type);
            keywordAt("close", data->closePosition, ")");
            end(start);
        }
        else
            fail("cst writer: unmodelled type at line " + std::to_string(node->location.begin.line + 1));
    }

    // A bare name (`nil` among them) may carry no CST data; a prefix or an
    // argument list always does.
    void typeReference(Luau::AstTypeReference* n)
    {
        Luau::CstTypeReference* data = nullptr;
        if (n->prefix || n->hasParameterList)
        {
            data = cstOf<Luau::CstTypeReference>(n, "type reference");
            if (!data)
                return;
        }
        Luau::Position start = begin("TypeReference");
        if (n->prefix)
        {
            if (!n->prefixLocation)
            {
                fail("cst writer: type prefix without a location at line " + std::to_string(n->location.begin.line + 1));
                return;
            }
            key("prefix");
            nameRef(n->prefixLocal, n->prefix->value, n->prefixLocation->begin);
            keywordAt("dot", data->prefixPointPosition, ".");
        }
        tok("name", n->nameLocation.begin, strlen(n->name.value));
        if (n->hasParameterList)
        {
            keywordAt("open", data->openParametersPosition, "<");
            punctuated("arguments", n->parameters.size, data->parametersCommaPositions, ",", [&](size_t i) {
                typeOrPack(n->parameters.data[i]);
            });
            keywordAt("close", data->closeParametersPosition, ">");
        }
        end(start);
    }

    // `read` or `write` before a table type member; the parser records its
    // position for table types but not for extern types.
    void access(Luau::AstTableAccess access, std::optional<Luau::Location> location)
    {
        if (access == Luau::AstTableAccess::ReadWrite)
            return;
        const char* text = access == Luau::AstTableAccess::Read ? "read" : "write";
        keywordAt("access", location ? location->begin : Luau::Position::missing(), text);
    }

    // Bytes of a string literal whose contents the lexer recorded.
    static size_t stringLength(const Luau::CstExprConstantString* info)
    {
        if (info->quoteStyle == Luau::CstExprConstantString::QuoteStyle::QuotedRaw)
            return info->sourceString.size + 4 + 2 * info->blockDepth;
        return info->sourceString.size + 2;
    }

    // Positions of a table type member's delimiters: recorded for table
    // types, missing (and so sought) for extern type bodies.
    struct MemberDelimiters
    {
        Luau::Position open = Luau::Position::missing();
        Luau::Position close = Luau::Position::missing();
        Luau::Position colon = Luau::Position::missing();
        Luau::Position separator = Luau::Position::missing();
    };

    // `[K]: V`
    void indexerMember(const Luau::AstTableIndexer* indexer, const MemberDelimiters& at)
    {
        Luau::Position start = begin("TypeTableItem");
        access(indexer->access, indexer->accessLocation);
        keywordAt("open", at.open, "[");
        key("key");
        type(indexer->indexType);
        keywordAt("close", at.close, "]");
        keywordAt("colon", at.colon, ":");
        key("value");
        type(indexer->resultType);
        if (has(at.separator))
            tok("separator", at.separator, 1);
        end(start);
    }

    // `name: T`, or `["name"]: T` when `bracketed`.
    void propertyMember(Luau::AstTableAccess propAccess, std::optional<Luau::Location> accessLocation, bool bracketed, Luau::Location name, Luau::AstType* value, const MemberDelimiters& at)
    {
        Luau::Position start = begin("TypeTableItem");
        access(propAccess, accessLocation);
        if (bracketed)
            keywordAt("open", at.open, "[");
        tokLoc("name", name);
        if (bracketed)
            keywordAt("close", at.close, "]");
        keywordAt("colon", at.colon, ":");
        key("value");
        type(value);
        if (has(at.separator))
            tok("separator", at.separator, 1);
        end(start);
    }

    void typeTable(Luau::AstTypeTable* n)
    {
        Luau::CstTypeTable* data = cstOf<Luau::CstTypeTable>(n, "table type");
        if (!data)
            return;
        Luau::Position start = begin("TypeTable");
        tok("open", n->location.begin, 1);
        key("items");
        openArr();
        if (data->isArray)
        {
            // `{ T }` desugars to an indexer whose key is a synthesized
            // `number` reference with an empty span.
            if (!n->indexer)
            {
                fail("cst writer: array type without an indexer at line " + std::to_string(n->location.begin.line + 1));
                return;
            }
            Luau::Position itemStart = begin("TypeTableItem");
            access(n->indexer->access, n->indexer->accessLocation);
            key("value");
            type(n->indexer->resultType);
            end(itemStart);
        }
        else
        {
            size_t propIndex = 0;
            for (size_t i = 0; i < data->items.size && !failed(); i++)
            {
                const Luau::CstTypeTable::Item& item = data->items.data[i];
                MemberDelimiters at;
                at.open = item.indexerOpenPosition;
                at.close = item.indexerClosePosition;
                at.colon = item.colonPosition;
                if (item.separator != Luau::CstExprTable::Separator::Missing)
                    at.separator = item.separatorPosition;
                if (item.kind == Luau::CstTypeTable::Item::Kind::Indexer)
                {
                    if (!n->indexer)
                    {
                        fail("cst writer: indexer item without an indexer at line " + std::to_string(n->location.begin.line + 1));
                        return;
                    }
                    indexerMember(n->indexer, at);
                    continue;
                }
                if (propIndex >= n->props.size)
                {
                    fail("cst writer: table type item count mismatch at line " + std::to_string(n->location.begin.line + 1));
                    return;
                }
                const Luau::AstTableProp& prop = n->props.data[propIndex++];
                bool bracketed = item.kind == Luau::CstTypeTable::Item::Kind::StringProperty;
                Luau::Location name = bracketed
                                          ? Luau::Location{item.stringPosition, positionOf(offsetOf(item.stringPosition) + stringLength(item.stringInfo))}
                                          : Luau::Location{prop.location.begin, after(prop.location.begin, strlen(prop.name.value))};
                propertyMember(prop.access, prop.accessLocation, bracketed, name, prop.type, at);
            }
        }
        closeArr();
        tokEnd("close", n->location, 1);
        end(start);
    }

    // `name: T`, `T`, or a method's bare `self`.
    void functionTypeArgument(const Luau::AstArgumentName* name, Luau::Position colon, Luau::AstType* annotation)
    {
        Luau::Position start = begin("FunctionTypeArgument");
        if (name)
            tok("name", name->second.begin, strlen(name->first.value));
        if (annotation)
        {
            if (name)
                keywordAt("colon", colon, ":");
            key("annotation");
            type(annotation);
        }
        end(start);
    }

    // `(a: T, U, ...V)`: names and colons run parallel to the types, and the
    // tail pack follows the last comma.
    void functionTypeArguments(
        const Luau::AstTypeList& list,
        Luau::AstArray<std::optional<Luau::AstArgumentName>> names,
        Luau::AstArray<Luau::Position> colons,
        Luau::AstArray<Luau::Position> commas
    )
    {
        punctuated("parameters", list.types.size, commas, ",", [&](size_t i) {
            const Luau::AstArgumentName* name = i < names.size && names.data[i] ? &*names.data[i] : nullptr;
            functionTypeArgument(name, i < colons.size ? colons.data[i] : Luau::Position::missing(), list.types.data[i]);
        });
        if (list.tailType)
        {
            key("tail");
            typePack(list.tailType);
        }
    }

    // `...` with its `: T` annotation, on a function or a signature.
    void varargTail(Luau::Position vararg, Luau::Position colon, Luau::AstTypePack* annotation)
    {
        keywordAt("vararg", vararg, "...");
        if (annotation)
        {
            keywordAt("varargColon", colon, ":");
            key("varargAnnotation");
            typePack(annotation);
        }
    }

    void returnAnnotation(Luau::Position colon, Luau::AstTypePack* pack)
    {
        keywordAt("returnColon", colon, ":");
        key("returnType");
        typePack(pack);
    }

    void typeFunction(Luau::AstTypeFunction* n)
    {
        Luau::CstTypeFunction* data = cstOf<Luau::CstTypeFunction>(n, "function type");
        if (!data)
            return;
        Luau::Position start = begin("TypeFunction");
        attrs(n->attributes, {});
        generics(n->generics, n->genericPacks, data->openGenericsPosition, data->genericsCommaPositions, data->closeGenericsPosition);
        keywordAt("open", data->openArgsPosition, "(");
        functionTypeArguments(n->argTypes, n->argNames, data->argumentNameColonPositions, data->argumentsCommaPositions);
        keywordAt("close", data->closeArgsPosition, ")");
        keywordAt("arrow", data->returnArrowPosition, "->");
        key("returnType");
        typePack(n->returnTypes);
        end(start);
    }

    // The members of a union or intersection already begun. The parser
    // stores `T?` as a part with no separator, so each member carries the
    // separator before it; a leading `|` is the first member's.
    void composite(Luau::Position start, Luau::AstArray<Luau::AstType*> types, Luau::Position leading, Luau::AstArray<Luau::Position> separators)
    {
        key("items");
        openArr();
        size_t separatorIndex = 0;
        for (size_t i = 0; i < types.size && !failed(); i++)
        {
            openObj();
            if (i == 0)
            {
                if (has(leading))
                    tok("separator", leading, 1);
            }
            else if (!types.data[i]->is<Luau::AstTypeOptional>())
            {
                if (separatorIndex >= separators.size)
                {
                    fail("cst writer: composite type separator count mismatch at line " + std::to_string(types.data[i]->location.begin.line + 1));
                    return;
                }
                tok("separator", separators.data[separatorIndex++], 1);
            }
            key("node");
            type(types.data[i]);
            closeObj();
        }
        closeArr();
        end(start);
    }

    void typePack(Luau::AstTypePack* node)
    {
        if (failed())
            return;
        if (auto n = node->as<Luau::AstTypePackExplicit>())
        {
            Luau::CstTypePackExplicit* data = cstOf<Luau::CstTypePackExplicit>(n, "explicit type pack");
            if (!data)
                return;
            // Parens are absent when a single type stands for the pack. A
            // return pack of one type and a tail, `(T, ...U)`, has them but
            // the parser records neither.
            bool parens = has(data->openParenthesesPosition) || (n->typeList.types.size == 1 && n->typeList.tailType);
            Luau::Position start = begin("TypePackExplicit");
            if (parens)
                keywordAt("open", data->openParenthesesPosition, "(");
            punctuated(
                "items",
                n->typeList.types.size,
                data->commaPositions,
                ",",
                [&](size_t i) {
                    type(n->typeList.types.data[i]);
                },
                n->typeList.tailType != nullptr
            );
            if (n->typeList.tailType)
            {
                key("tail");
                typePack(n->typeList.tailType);
            }
            if (parens)
                keywordAt("close", data->closeParenthesesPosition, ")");
            end(start);
        }
        else if (auto n = node->as<Luau::AstTypePackVariadic>())
        {
            // A function's `...: T` annotation is a variadic pack without
            // the ellipsis: that token belongs to the parameter list.
            Luau::Position start = begin("TypePackVariadic");
            if (peekByte() == '.')
                seek("ellipsis", "...");
            key("inner");
            type(n->variadicType);
            end(start);
        }
        else if (auto n = node->as<Luau::AstTypePackGeneric>())
        {
            Luau::CstTypePackGeneric* data = cstOf<Luau::CstTypePackGeneric>(n, "generic type pack");
            if (!data)
                return;
            Luau::Position start = begin("TypePackGeneric");
            tok("name", n->location.begin, strlen(n->genericName.value));
            keywordAt("ellipsis", data->ellipsisPosition, "...");
            end(start);
        }
        else
            fail("cst writer: unmodelled type pack at line " + std::to_string(node->location.begin.line + 1));
    }

    void typeOrPack(const Luau::AstTypeOrPack& node)
    {
        if (node.type)
            type(node.type);
        else if (node.typePack)
            typePack(node.typePack);
        else
            fail("cst writer: empty type argument");
    }

    void generic(Luau::AstGenericType* node)
    {
        Luau::CstGenericType* data = cstOf<Luau::CstGenericType>(node, "generic type");
        if (!data)
            return;
        Luau::Position start = begin("GenericType");
        tok("name", node->location.begin, strlen(node->name.value));
        if (node->defaultValue)
        {
            keywordAt("equals", data->defaultEqualsPosition, "=");
            key("default");
            type(node->defaultValue);
        }
        end(start);
    }

    void genericPack(Luau::AstGenericTypePack* node)
    {
        Luau::CstGenericTypePack* data = cstOf<Luau::CstGenericTypePack>(node, "generic type pack");
        if (!data)
            return;
        Luau::Position start = begin("GenericTypePack");
        tok("name", node->location.begin, strlen(node->name.value));
        keywordAt("ellipsis", data->ellipsisPosition, "...");
        if (node->defaultValue)
        {
            keywordAt("equals", data->defaultEqualsPosition, "=");
            key("default");
            typePack(node->defaultValue);
        }
        end(start);
    }

    // ---- punctuated lists: [{"node": X, "separator": Token}, ...] ----

    // A list whose separators went unrecorded (a `declare` signature) has
    // one between each pair of items, and one after the last when a tail
    // follows.
    template<typename F>
    void punctuated(const char* name, size_t count, Luau::AstArray<Luau::Position> separators, const char* separator, F each, bool trailing = false)
    {
        key(name);
        openArr();
        for (size_t i = 0; i < count && !failed(); i++)
        {
            openObj();
            key("node");
            each(i);
            if (i < separators.size)
            {
                if (has(separators.data[i]))
                    keyword("separator", separators.data[i], separator);
            }
            else if (separators.size == 0 && (i + 1 < count || trailing))
                seek("separator", separator);
            closeObj();
        }
        closeArr();
    }

    void exprs(const char* name, Luau::AstArray<Luau::AstExpr*> list, Luau::AstArray<Luau::Position> commas)
    {
        punctuated(name, list.size, commas, ",", [&](size_t i) {
            expr(list.data[i]);
        });
    }

    void localDecl(Luau::AstLocal* local, Luau::Position colon)
    {
        begin("LocalDecl", local->location);
        key("binding");
        num(binding(local));
        tok("name", local->location.begin, strlen(local->name.value));
        if (local->annotation)
        {
            tok("colon", colon, 1);
            key("annotation");
            type(local->annotation);
        }
        closeObj();
    }

    void locals(
        const char* name,
        Luau::AstArray<Luau::AstLocal*> list,
        Luau::AstArray<Luau::Position> commas,
        Luau::AstArray<Luau::Position> colons
    )
    {
        punctuated(name, list.size, commas, ",", [&](size_t i) {
            localDecl(list.data[i], i < colons.size ? colons.data[i] : Luau::Position::missing());
        });
    }

    // Delimiter positions are recorded except on a `declare function`.
    void generics(
        Luau::AstArray<Luau::AstGenericType*> types,
        Luau::AstArray<Luau::AstGenericTypePack*> packs,
        Luau::Position open = Luau::Position::missing(),
        Luau::AstArray<Luau::Position> commas = {},
        Luau::Position close = Luau::Position::missing()
    )
    {
        if (types.size == 0 && packs.size == 0)
            return;
        key("generics");
        Luau::Position start = begin("Generics");
        keywordAt("open", open, "<");
        punctuated("items", types.size + packs.size, commas, ",", [&](size_t i) {
            if (i < types.size)
                generic(types.data[i]);
            else
                genericPack(packs.data[i - types.size]);
        });
        keywordAt("close", close, ">");
        end(start);
    }

    void typeArguments(Luau::AstArray<Luau::AstTypeOrPack> list, const Luau::CstTypeInstantiation& data)
    {
        key("typeArguments");
        Luau::Position start = begin("TypeArguments");
        keyword("open1", data.leftArrow1Position, "<");
        keyword("open2", data.leftArrow2Position, "<");
        punctuated("items", list.size, data.commaPositions, ",", [&](size_t i) {
            typeOrPack(list.data[i]);
        });
        keyword("close1", data.rightArrow1Position, ">");
        keyword("close2", data.rightArrow2Position, ">");
        end(start);
    }

    // Whether an attribute was written `@name` on its own rather than inside
    // a bracketed list.
    bool bare(Luau::AstAttr* attr)
    {
        if (!cst.find(attr))
        {
            fail("cst writer: missing CST data for attribute at line " + std::to_string(attr->location.begin.line + 1));
            return false;
        }
        const Luau::CstAttr* data = tryCstOf<Luau::CstAttr>(attr);
        return data && data->hasAt;
    }

    void attribute(Luau::AstAttr* attr, bool isBare)
    {
        Luau::Position start = begin("Attribute");
        if (isBare)
        {
            // One lexeme, `@name`, split so the name reads the same as in a
            // list.
            keyword("at", attr->location.begin, "@");
            token("name", after(attr->location.begin, 1), attr->location.end);
        }
        else
        {
            tok("name", attr->location.begin, strlen(attr->name.value));
            if (auto data = tryCstOf<Luau::CstParametrizedAttr>(attr))
            {
                // `@[deprecated { use = "x" }]` passes its argument without
                // parens.
                if (has(data->openParenPosition))
                    tok("open", data->openParenPosition, 1);
                exprs("arguments", attr->args, data->argsCommaPositions);
                if (has(data->closeParenPosition))
                    tok("close", data->closeParenPosition, 1);
            }
            else if (attr->args.size > 0)
                fail("cst writer: attribute arguments without CST data at line " + std::to_string(attr->location.begin.line + 1));
        }
        end(start);
    }

    // Attributes in source order, each bare or grouped into its bracketed
    // list. The parser records list delimiters for functions only; elsewhere
    // (a `declare`, an extern type method) the source decides where a list
    // ends.
    void attrs(Luau::AstArray<Luau::AstAttr*> list, Luau::AstArray<Luau::CstAttrList*> lists)
    {
        if (list.size == 0)
            return;
        key("attributes");
        openArr();
        size_t i = 0;
        size_t listIndex = 0;
        while (i < list.size && !failed())
        {
            if (bare(list.data[i]))
            {
                attribute(list.data[i++], true);
                continue;
            }
            Luau::CstAttrList* group = listIndex < lists.size ? lists.data[listIndex++] : nullptr;
            Luau::Position start = begin("AttributeList");
            keywordAt("open", group ? group->atBracketPosition : Luau::Position::missing(), "@[");
            key("items");
            openArr();
            size_t comma = 0;
            while (!failed())
            {
                openObj();
                key("node");
                attribute(list.data[i++], false);
                bool more = group ? comma < group->commaPositions.size : peekByte() == ',';
                if (more)
                    keywordAt("separator", group ? group->commaPositions.data[comma++] : Luau::Position::missing(), ",");
                closeObj();
                if (!more)
                    break;
                if (i >= list.size || bare(list.data[i]))
                {
                    fail("cst writer: attribute list ends early at line " + std::to_string(list.data[i - 1]->location.begin.line + 1));
                    break;
                }
            }
            closeArr();
            keywordAt("close", group ? group->closeBracketPosition : Luau::Position::missing(), "]");
            end(start);
        }
        closeArr();
    }

    // ---- blocks and functions ----

    void block(const char* name, Luau::AstStatBlock* block)
    {
        key(name);
        begin("Block", block->location);
        key("body");
        openArr();
        for (size_t i = 0; i < block->body.size; i++)
            stat(block->body.data[i]);
        closeArr();
        closeObj();
    }

    // Everything after the `function` keyword (and, for statements, the
    // name): generics, parameters, return annotation, block, `end`.
    void functionBody(Luau::AstExprFunction* function)
    {
        Luau::CstExprFunction* data = cstOf<Luau::CstExprFunction>(function, "function");
        if (!data)
            return;
        key("body");
        begin("FunctionBody", function->location);
        generics(function->generics, function->genericPacks, data->openGenericsPosition, data->genericsCommaPositions, data->closeGenericsPosition);
        if (!function->argLocation)
        {
            fail("cst writer: function without a parameter list at line " + std::to_string(function->location.begin.line + 1));
            return;
        }
        tok("open", function->argLocation->begin, 1);
        locals("parameters", function->args, data->argsCommaPositions, data->argsAnnotationColonPositions);
        if (function->vararg)
            varargTail(function->varargLocation.begin, data->varargAnnotationColonPosition, function->varargAnnotation);
        tokEnd("close", *function->argLocation, 1);
        if (function->returnAnnotation)
            returnAnnotation(data->returnSpecifierPosition, function->returnAnnotation);
        block("block", function->body);
        keyword("end", function->body->location.end, "end");
        closeObj();
    }

    // ---- expressions ----

    void expr(Luau::AstExpr* node)
    {
        if (failed())
            return;
        if (auto n = node->as<Luau::AstExprGroup>())
        {
            begin("Group", n->location);
            tok("open", n->location.begin, 1);
            key("expr");
            expr(n->expr);
            if (auto data = cstOf<Luau::CstExprGroup>(n, "group"))
                tok("close", data->closePosition, 1);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprConstantNil>())
        {
            begin("Nil", n->location);
            tokLoc("token", n->location);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprConstantBool>())
        {
            begin("Bool", n->location);
            tokLoc("token", n->location);
            closeObj();
        }
        else if (node->is<Luau::AstExprConstantNumber>() || node->is<Luau::AstExprConstantInteger>())
        {
            begin("Number", node->location);
            tokLoc("token", node->location);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprConstantString>())
        {
            begin("String", n->location);
            tokLoc("token", n->location);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprLocal>())
            nameRef(n->local, n->local->name.value, n->location.begin);
        else if (auto n = node->as<Luau::AstExprGlobal>())
            nameRef(nullptr, n->name.value, n->location.begin);
        else if (auto n = node->as<Luau::AstExprVarargs>())
        {
            begin("Varargs", n->location);
            keyword("token", n->location.begin, "...");
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprCall>())
        {
            Luau::CstExprCall* data = cstOf<Luau::CstExprCall>(n, "call");
            if (!data)
                return;
            begin("Call", n->location);
            key("callee");
            expr(n->func);
            // The parser allocates the instantiation record for every method
            // call; only a written `<<...>>` fills its positions in.
            if (data->explicitTypes && has(data->explicitTypes->leftArrow1Position))
                typeArguments(n->typeArguments, *data->explicitTypes);
            if (has(data->openParens))
                tok("open", data->openParens, 1);
            exprs("arguments", n->args, data->commaPositions);
            if (has(data->closeParens))
                tok("close", data->closeParens, 1);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprIndexName>())
        {
            begin("IndexName", n->location);
            key("expr");
            expr(n->expr);
            tok("operator", n->opPosition, 1);
            tok("index", n->indexLocation.begin, strlen(n->index.value));
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprIndexExpr>())
        {
            Luau::CstExprIndexExpr* data = cstOf<Luau::CstExprIndexExpr>(n, "index expression");
            if (!data)
                return;
            begin("IndexExpr", n->location);
            key("expr");
            expr(n->expr);
            tok("open", data->openBracketPosition, 1);
            key("index");
            expr(n->index);
            tok("close", data->closeBracketPosition, 1);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprFunction>())
        {
            Luau::CstExprFunction* data = cstOf<Luau::CstExprFunction>(n, "function");
            if (!data)
                return;
            begin("FunctionExpr", n->location);
            attrs(n->attributes, data->attrLists);
            keyword("keyword", data->functionKeywordPosition, "function");
            functionBody(n);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprTable>())
        {
            Luau::CstExprTable* data = cstOf<Luau::CstExprTable>(n, "table");
            if (!data)
                return;
            if (data->items.size != n->items.size)
            {
                fail("cst writer: table item count mismatch at line " + std::to_string(n->location.begin.line + 1));
                return;
            }
            begin("Table", n->location);
            tok("open", n->location.begin, 1);
            key("items");
            openArr();
            for (size_t i = 0; i < n->items.size; i++)
            {
                const Luau::AstExprTable::Item& item = n->items.data[i];
                const Luau::CstExprTable::Item& itemData = data->items.data[i];
                begin("TableItem", Luau::Location{item.key ? item.key->location.begin : item.value->location.begin, item.value->location.end});
                if (item.kind == Luau::AstExprTable::Item::Kind::General)
                {
                    tok("open", itemData.indexerOpenPosition, 1);
                    key("key");
                    expr(item.key);
                    tok("close", itemData.indexerClosePosition, 1);
                    tok("equals", itemData.equalsPosition, 1);
                }
                else if (item.kind == Luau::AstExprTable::Item::Kind::Record)
                {
                    key("key");
                    expr(item.key);
                    tok("equals", itemData.equalsPosition, 1);
                }
                key("value");
                expr(item.value);
                if (itemData.separator != Luau::CstExprTable::Separator::Missing)
                    tok("separator", itemData.separatorPosition, 1);
                closeObj();
            }
            closeArr();
            tokEnd("close", n->location, 1);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprUnary>())
        {
            Luau::CstExprOp* data = cstOf<Luau::CstExprOp>(n, "unary operator");
            if (!data)
                return;
            begin("Unary", n->location);
            tok("operator", data->opPosition, Luau::toString(n->op).size());
            key("expr");
            expr(n->expr);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprBinary>())
        {
            Luau::CstExprOp* data = cstOf<Luau::CstExprOp>(n, "binary operator");
            if (!data)
                return;
            begin("Binary", n->location);
            key("left");
            expr(n->left);
            tok("operator", data->opPosition, Luau::toString(n->op).size());
            key("right");
            expr(n->right);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprTypeAssertion>())
        {
            Luau::CstExprTypeAssertion* data = cstOf<Luau::CstExprTypeAssertion>(n, "type assertion");
            if (!data)
                return;
            begin("TypeAssertion", n->location);
            key("expr");
            expr(n->expr);
            keyword("operator", data->opPosition, "::");
            key("annotation");
            type(n->annotation);
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprIfElse>())
        {
            Luau::CstExprIfElse* data = cstOf<Luau::CstExprIfElse>(n, "if expression");
            if (!data)
                return;
            begin("IfElse", n->location);
            keyword("if", n->location.begin, "if");
            key("condition");
            expr(n->condition);
            if (n->hasThen)
                keyword("then", data->thenPosition, "then");
            key("trueExpr");
            expr(n->trueExpr);
            key("elseifs");
            openArr();
            while (!failed() && n->hasElse && n->falseExpr->is<Luau::AstExprIfElse>() && data->isElseIf)
            {
                n = n->falseExpr->as<Luau::AstExprIfElse>();
                data = cstOf<Luau::CstExprIfElse>(n, "elseif expression");
                if (!data)
                    return;
                begin("ElseIfExpr", n->location);
                keyword("keyword", n->location.begin, "elseif");
                key("condition");
                expr(n->condition);
                if (n->hasThen)
                    keyword("then", data->thenPosition, "then");
                key("trueExpr");
                expr(n->trueExpr);
                closeObj();
            }
            closeArr();
            if (n->hasElse)
            {
                keyword("else", data->elsePosition, "else");
                key("falseExpr");
                expr(n->falseExpr);
            }
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprInterpString>())
        {
            // Parts alternate string segments and expressions. A segment
            // carries its delimiters and the whitespace inside the braces,
            // so the segments and expressions tile the whole literal.
            begin("InterpString", n->location);
            key("parts");
            openArr();
            Luau::Position cursor = n->location.begin;
            for (size_t i = 0; i < n->expressions.size; i++)
            {
                Luau::AstExpr* expression = n->expressions.data[i];
                tokenValue(cursor, expression->location.begin);
                expr(expression);
                cursor = expression->location.end;
            }
            tokenValue(cursor, n->location.end);
            closeArr();
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprInstantiate>())
        {
            Luau::CstExprExplicitTypeInstantiation* data = cstOf<Luau::CstExprExplicitTypeInstantiation>(n, "type instantiation");
            if (!data)
                return;
            begin("Instantiate", n->location);
            key("expr");
            expr(n->expr);
            typeArguments(n->typeArguments, data->instantiation);
            closeObj();
        }
        else
            fail("cst writer: unmodelled expression at line " + std::to_string(node->location.begin.line + 1));
    }

    // ---- statements ----

    void stat(Luau::AstStat* node)
    {
        if (failed())
            return;
        // statBody leaves the node object open so the semicolon lands last,
        // and returns a start for a statement whose location is derived.
        Luau::Position derived = statBody(node);
        if (node->hasSemicolon)
            tokEnd("semicolon", node->location, 1);
        if (has(derived))
            end(derived);
        else
            closeObj();
    }

    // Whether a `declare` signature's return pack was written or is the
    // empty pack the parser synthesizes at the next token.
    bool synthesizedReturn(Luau::AstTypePack* pack)
    {
        auto explicitPack = pack->as<Luau::AstTypePackExplicit>();
        return explicitPack && explicitPack->typeList.types.size == 0 && !explicitPack->typeList.tailType && !cst.find(pack);
    }

    // `(self, a: T, ...: U): R` on a `declare function` or an extern type
    // method: the parser records the names' positions and nothing else, so
    // `names[i]` is the i-th annotated parameter and every delimiter is
    // sought.
    void signature(
        bool hasSelf,
        const Luau::AstTypeList& params,
        const Luau::AstArgumentName* names,
        bool vararg,
        Luau::Position varargPosition,
        Luau::AstTypePack* returnTypes
    )
    {
        seek("open", "(");
        size_t count = params.types.size + (hasSelf ? 1 : 0);
        punctuated(
            "parameters",
            count,
            {},
            ",",
            [&](size_t i) {
                if (hasSelf && i == 0)
                {
                    Luau::Position start = begin("FunctionTypeArgument");
                    seek("name", "self");
                    end(start);
                    return;
                }
                size_t index = hasSelf ? i - 1 : i;
                functionTypeArgument(&names[index], Luau::Position::missing(), params.types.data[index]);
            },
            vararg
        );
        if (vararg)
            varargTail(varargPosition, Luau::Position::missing(), params.tailType);
        seek("close", ")");
        if (!synthesizedReturn(returnTypes))
            returnAnnotation(Luau::Position::missing(), returnTypes);
    }

    void externTypeMember(const Luau::AstDeclaredExternTypeProperty& prop)
    {
        if (prop.isMethod)
        {
            auto function = prop.ty->as<Luau::AstTypeFunction>();
            if (!function)
            {
                fail("cst writer: extern type method without a function type at line " + std::to_string(prop.location.begin.line + 1));
                return;
            }
            Luau::Position start = begin("ExternTypeMethod");
            attrs(function->attributes, {});
            seek("function", "function");
            tok("name", prop.nameLocation.begin, strlen(prop.name.value));
            std::vector<Luau::AstArgumentName> names;
            for (size_t i = 0; i < function->argNames.size; i++)
            {
                if (!function->argNames.data[i])
                {
                    fail("cst writer: unnamed extern type method parameter at line " + std::to_string(prop.location.begin.line + 1));
                    return;
                }
                names.push_back(*function->argNames.data[i]);
            }
            signature(true, function->argTypes, names.data(), function->argTypes.tailType != nullptr, Luau::Position::missing(), function->returnTypes);
            end(start);
            return;
        }
        // A `["name"]` property's location starts at the bracket.
        MemberDelimiters at;
        bool bracketed = byteAt(prop.location.begin) == '[';
        if (bracketed)
            at.open = prop.location.begin;
        propertyMember(prop.access, std::nullopt, bracketed, prop.nameLocation, prop.ty, at);
    }

    void externTypeIndexer(const Luau::AstTableIndexer* indexer)
    {
        MemberDelimiters at;
        at.open = indexer->location.begin;
        indexerMember(indexer, at);
    }

    Luau::Position statBody(Luau::AstStat* node)
    {
        Luau::Position derived = Luau::Position::missing();
        if (auto n = node->as<Luau::AstStatBlock>())
        {
            Luau::CstStatDo* data = cstOf<Luau::CstStatDo>(n, "do block");
            if (!data)
                return derived;
            begin("Do", n->location);
            keyword("do", n->location.begin, "do");
            block("body", n);
            keyword("end", data->endPosition, "end");
        }
        else if (auto n = node->as<Luau::AstStatIf>())
        {
            begin("If", n->location);
            keyword("if", n->location.begin, "if");
            key("condition");
            expr(n->condition);
            if (n->thenLocation)
                keyword("then", n->thenLocation->begin, "then");
            block("body", n->thenbody);
            key("elseifs");
            openArr();
            while (!failed() && n->elsebody && n->elsebody->is<Luau::AstStatIf>())
            {
                n = n->elsebody->as<Luau::AstStatIf>();
                begin("ElseIf", n->location);
                keyword("keyword", n->location.begin, "elseif");
                key("condition");
                expr(n->condition);
                if (n->thenLocation)
                    keyword("then", n->thenLocation->begin, "then");
                block("body", n->thenbody);
                closeObj();
            }
            closeArr();
            if (n->elsebody)
            {
                if (n->elseLocation)
                    keyword("else", n->elseLocation->begin, "else");
                Luau::AstStatBlock* elseBlock = n->elsebody->as<Luau::AstStatBlock>();
                if (!elseBlock)
                {
                    fail("cst writer: else branch is not a block at line " + std::to_string(n->location.begin.line + 1));
                    return derived;
                }
                block("elseBody", elseBlock);
                keyword("end", elseBlock->location.end, "end");
            }
            else
                keyword("end", n->thenbody->location.end, "end");
        }
        else if (auto n = node->as<Luau::AstStatWhile>())
        {
            begin("While", n->location);
            keyword("while", n->location.begin, "while");
            key("condition");
            expr(n->condition);
            if (n->hasDo)
                keyword("do", n->doLocation.begin, "do");
            block("body", n->body);
            keyword("end", n->body->location.end, "end");
        }
        else if (auto n = node->as<Luau::AstStatRepeat>())
        {
            Luau::CstStatRepeat* data = cstOf<Luau::CstStatRepeat>(n, "repeat");
            if (!data)
                return derived;
            begin("Repeat", n->location);
            keyword("repeat", n->location.begin, "repeat");
            block("body", n->body);
            keyword("until", data->untilPosition, "until");
            key("condition");
            expr(n->condition);
        }
        else if (auto n = node->as<Luau::AstStatBreak>())
        {
            begin("Break", n->location);
            keyword("token", n->location.begin, "break");
        }
        else if (auto n = node->as<Luau::AstStatContinue>())
        {
            begin("Continue", n->location);
            keyword("token", n->location.begin, "continue");
        }
        else if (auto n = node->as<Luau::AstStatReturn>())
        {
            Luau::CstStatReturn* data = cstOf<Luau::CstStatReturn>(n, "return");
            if (!data)
                return derived;
            begin("Return", n->location);
            keyword("keyword", n->location.begin, "return");
            exprs("values", n->list, data->commaPositions);
        }
        else if (auto n = node->as<Luau::AstStatExpr>())
        {
            begin("ExprStat", n->location);
            key("expr");
            expr(n->expr);
        }
        else if (auto n = node->as<Luau::AstStatLocal>())
        {
            Luau::CstStatLocal* data = cstOf<Luau::CstStatLocal>(n, "local");
            if (!data)
                return derived;
            begin("Local", n->location);
            // `local` and `const` are both five bytes.
            if (n->isExported && n->keywordLocation)
            {
                keyword("export", n->location.begin, "export");
                tok("keyword", n->keywordLocation->begin, 5);
            }
            else
                tok("keyword", n->location.begin, 5);
            locals("variables", n->vars, data->varsCommaPositions, data->varsAnnotationColonPositions);
            if (n->equalsSignLocation)
                tok("equals", n->equalsSignLocation->begin, 1);
            exprs("values", n->values, data->valuesCommaPositions);
        }
        else if (auto n = node->as<Luau::AstStatFor>())
        {
            Luau::CstStatFor* data = cstOf<Luau::CstStatFor>(n, "numeric for");
            if (!data)
                return derived;
            begin("For", n->location);
            keyword("for", n->location.begin, "for");
            key("variable");
            localDecl(n->var, data->annotationColonPosition);
            tok("equals", data->equalsPosition, 1);
            key("from");
            expr(n->from);
            tok("fromComma", data->endCommaPosition, 1);
            key("to");
            expr(n->to);
            if (n->step)
            {
                tok("toComma", data->stepCommaPosition, 1);
                key("step");
                expr(n->step);
            }
            if (n->hasDo)
                keyword("do", n->doLocation.begin, "do");
            block("body", n->body);
            keyword("end", n->body->location.end, "end");
        }
        else if (auto n = node->as<Luau::AstStatForIn>())
        {
            Luau::CstStatForIn* data = cstOf<Luau::CstStatForIn>(n, "generic for");
            if (!data)
                return derived;
            begin("ForIn", n->location);
            keyword("for", n->location.begin, "for");
            locals("variables", n->vars, data->varsCommaPositions, data->varsAnnotationColonPositions);
            if (n->hasIn)
                keyword("in", n->inLocation.begin, "in");
            exprs("values", n->values, data->valuesCommaPositions);
            if (n->hasDo)
                keyword("do", n->doLocation.begin, "do");
            block("body", n->body);
            keyword("end", n->body->location.end, "end");
        }
        else if (auto n = node->as<Luau::AstStatAssign>())
        {
            Luau::CstStatAssign* data = cstOf<Luau::CstStatAssign>(n, "assignment");
            if (!data)
                return derived;
            begin("Assign", n->location);
            exprs("variables", n->vars, data->varsCommaPositions);
            tok("equals", data->equalsPosition, 1);
            exprs("values", n->values, data->valuesCommaPositions);
        }
        else if (auto n = node->as<Luau::AstStatCompoundAssign>())
        {
            Luau::CstStatCompoundAssign* data = cstOf<Luau::CstStatCompoundAssign>(n, "compound assignment");
            if (!data)
                return derived;
            begin("CompoundAssign", n->location);
            key("variable");
            expr(n->var);
            tok("operator", data->opPosition, Luau::toString(n->op).size() + 1);
            key("value");
            expr(n->value);
        }
        else if (auto n = node->as<Luau::AstStatFunction>())
        {
            Luau::CstStatFunction* data = cstOf<Luau::CstStatFunction>(n, "function statement");
            if (!data)
                return derived;
            begin("FunctionStat", n->location);
            attrs(n->func->attributes, data->attrLists);
            keyword("keyword", data->functionKeywordPosition, "function");
            key("name");
            expr(n->name);
            functionBody(n->func);
        }
        else if (auto n = node->as<Luau::AstStatLocalFunction>())
        {
            Luau::CstStatLocalFunction* data = cstOf<Luau::CstStatLocalFunction>(n, "local function");
            if (!data)
                return derived;
            begin("LocalFunction", n->location);
            attrs(n->func->attributes, data->attrLists);
            // `export function f` parses as an exported local function whose
            // keyword position is the `export`; `local` and `const` are both
            // five bytes.
            if (n->name->isExported)
                keyword("export", data->localKeywordPosition, "export");
            else
                tok("local", data->localKeywordPosition, 5);
            keyword("keyword", data->functionKeywordPosition, "function");
            key("name");
            localDecl(n->name, Luau::Position::missing());
            functionBody(n->func);
        }
        else if (auto n = node->as<Luau::AstStatTypeAlias>())
        {
            Luau::CstStatTypeAlias* data = cstOf<Luau::CstStatTypeAlias>(n, "type alias");
            if (!data)
                return derived;
            begin("TypeAlias", n->location);
            if (n->exported)
                keyword("export", n->location.begin, "export");
            keyword("keyword", data->typeKeywordPosition, "type");
            tok("name", n->nameLocation.begin, strlen(n->name.value));
            generics(n->generics, n->genericPacks, data->genericsOpenPosition, data->genericsCommaPositions, data->genericsClosePosition);
            tok("equals", data->equalsPosition, 1);
            key("value");
            type(n->type);
        }
        else if (auto n = node->as<Luau::AstStatTypeFunction>())
        {
            Luau::CstStatTypeFunction* data = cstOf<Luau::CstStatTypeFunction>(n, "type function");
            if (!data)
                return derived;
            begin("TypeFunctionStat", n->location);
            if (n->exported)
                keyword("export", n->location.begin, "export");
            keyword("keyword", data->typeKeywordPosition, "type");
            keyword("function", data->functionKeywordPosition, "function");
            tok("name", n->nameLocation.begin, strlen(n->name.value));
            functionBody(n->body);
        }
        else if (auto n = node->as<Luau::AstStatDeclareGlobal>())
        {
            derived = begin("DeclareGlobal");
            keyword("declare", n->location.begin, "declare");
            tok("name", n->nameLocation.begin, strlen(n->name.value));
            seek("colon", ":");
            key("annotation");
            type(n->type);
        }
        else if (auto n = node->as<Luau::AstStatDeclareFunction>())
        {
            // The parser runs the location on to the next token and records
            // no delimiter positions; the tokens decide both.
            derived = begin("DeclareFunction");
            attrs(n->attributes, {});
            keyword("declare", n->location.begin, "declare");
            seek("function", "function");
            tok("name", n->nameLocation.begin, strlen(n->name.value));
            generics(n->generics, n->genericPacks);
            signature(false, n->params, n->paramNames.data, n->vararg, n->varargLocation.begin, n->retTypes);
        }
        else if (auto n = node->as<Luau::AstStatDeclareExternType>())
        {
            // The location starts at the name; `declare extern type` and
            // everything inside the body but the names go unrecorded.
            derived = begin("DeclareExternType");
            seek("declare", "declare");
            seek("extern", "extern");
            seek("keyword", "type");
            tok("name", n->location.begin, strlen(n->name.value));
            if (n->superName)
            {
                seek("extends", "extends");
                seek("super", n->superName->value);
            }
            seek("with", "with");
            key("members");
            openArr();
            size_t propIndex = 0;
            bool indexerPending = n->indexer != nullptr;
            while ((propIndex < n->props.size || indexerPending) && !failed())
            {
                bool indexerNext =
                    indexerPending && (propIndex >= n->props.size || n->indexer->location.begin < n->props.data[propIndex].location.begin);
                if (indexerNext)
                {
                    externTypeIndexer(n->indexer);
                    indexerPending = false;
                }
                else
                    externTypeMember(n->props.data[propIndex++]);
            }
            closeArr();
            seek("end", "end");
        }
        else
            fail("cst writer: unmodelled statement at line " + std::to_string(node->location.begin.line + 1));
        return derived;
    }

    // The end-of-file token is the TypeScript side's to add: it already
    // knows the source length.
    void root(Luau::AstStatBlock* rootBlock)
    {
        begin("Root", rootBlock->location);
        block("body", rootBlock);
        closeObj();
        if (cstFaultArmed)
        {
            cstFaultArmed = false;
            closeObj();
        }
        if (!failed() && !needComma.empty())
            fail("cst writer: unbalanced containers at end of file");
    }
};

// Copy `text` into a malloc'd NUL-terminated buffer the caller frees.
char* transfer(const std::string& text)
{
    char* result = static_cast<char*>(malloc(text.size() + 1));
    memcpy(result, text.data(), text.size());
    result[text.size()] = '\0';
    return result;
}

Luau::ParseResult parse(const char* src, size_t len, Luau::Allocator& allocator, Luau::AstNameTable& names, bool storeCstData)
{
    initFlags();

    Luau::ParseOptions options;
    options.captureComments = true;
    options.allowDeclarationSyntax = true;
    options.storeCstData = storeCstData;

    return Luau::Parser::parse(src, len, names, allocator, std::move(options));
}

std::string parseErrors(const Luau::ParseResult& parseResult)
{
    std::string out;
    out.push_back(PARSE_ERROR_MARKER);
    for (const Luau::ParseError& error : parseResult.errors)
    {
        out += error.getMessage();
        out.push_back('\n');
    }
    return out;
}

} // namespace

extern "C"
{

// Returns a malloc'd NUL-terminated string. On success it is the AST JSON; on
// parse error it starts with "\x01" and carries newline-separated messages.
// Ownership transfers to the caller: free with free_result.
const char* parse_to_json(const char* src, size_t len)
{
    Luau::Allocator allocator;
    Luau::AstNameTable names(allocator);
    Luau::ParseResult parseResult = parse(src, len, allocator, names, false);

    if (!parseResult.errors.empty())
        return transfer(parseErrors(parseResult));
    return transfer(Luau::toJson(parseResult.root, parseResult.commentLocations));
}

// Same contract as parse_to_json, but the payload is the position-only tree
// CstWriter describes, and a serializer defect starts with "\x02" and carries
// one message.
const char* parse_to_cst_json(const char* src, size_t len)
{
    Luau::Allocator allocator;
    Luau::AstNameTable names(allocator);
    Luau::ParseResult parseResult = parse(src, len, allocator, names, true);

    if (!parseResult.errors.empty())
        return transfer(parseErrors(parseResult));

    try
    {
        CstWriter writer(parseResult.cstNodeMap, src, len);
        // The tree JSON is a small constant multiple of the source length.
        writer.out.reserve(len * 8);
        writer.root(parseResult.root);
        if (writer.failed())
            return transfer(DEFECT_MARKER + writer.failure);
        return transfer(writer.out);
    }
    catch (const std::exception& error)
    {
        return transfer(DEFECT_MARKER + std::string("cst writer: ") + error.what());
    }
}

// Test hook: the next parse_to_cst_json call trips the writer's own guard,
// proving a defect comes back as a message rather than a trap.
void inject_cst_fault()
{
    cstFaultArmed = true;
}

void free_result(const char* ptr)
{
    free(const_cast<char*>(ptr));
}

} // extern "C"
