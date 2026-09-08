// Thin WASM wrapper around the official Luau parser, modeled on CLI/src/Ast.cpp.
#include "Luau/Ast.h"
#include "Luau/AstJsonEncoder.h"
#include "Luau/Common.h"
#include "Luau/Cst.h"
#include "Luau/ParseOptions.h"
#include "Luau/ParseResult.h"
#include "Luau/Parser.h"

#include <cstdlib>
#include <cstring>
#include <exception>
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
// Kinds the walker does not model come out as {"type":"Raw"} over the node's
// span: every type node, type pack, generic, and attribute for now.
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

    explicit CstWriter(const Luau::CstNodeMap& cst)
        : cst(cst)
    {
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

    // A single-line token of `length` bytes starting at `begin`.
    void tok(const char* name, Luau::Position begin, size_t length)
    {
        if (failed())
            return;
        if (!has(begin))
        {
            fail(std::string("cst writer: missing position for token '") + name + "'");
            return;
        }
        key(name);
        span(begin, Luau::Position{begin.line, begin.column + unsigned(length)});
    }

    // A keyword or fixed punctuation whose length is the literal's.
    void keyword(const char* name, Luau::Position begin, const char* text)
    {
        tok(name, begin, strlen(text));
    }

    void tokLoc(const char* name, Luau::Location location)
    {
        key(name);
        span(location);
    }

    // Push a location's end forward: the parser's own end for several node
    // kinds stops short of what it consumed.
    static void extend(Luau::Location& location, Luau::Position end)
    {
        if (location.end < end)
            location.end = end;
    }

    static void extend(Luau::Location& location, const Luau::AstTypeList& types)
    {
        for (size_t i = 0; i < types.types.size; i++)
            extend(location, types.types.data[i]->location.end);
        if (types.tailType)
            extend(location, types.tailType->location.end);
    }

    static Luau::Position after(Luau::Position begin, size_t length)
    {
        return Luau::Position{begin.line, begin.column + unsigned(length)};
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
        key(name);
        span(Luau::Position{location.end.line, location.end.column - unsigned(length)}, location.end);
    }

    template<typename T>
    T* cstOf(Luau::AstNode* node, const char* kind)
    {
        Luau::CstNode* const* found = cst.find(node);
        T* data = found ? (*found)->as<T>() : nullptr;
        if (!data)
            fail(std::string("cst writer: missing CST data for ") + kind + " at line " + std::to_string(node->location.begin.line + 1));
        return data;
    }

    void begin(const char* type, Luau::Location location)
    {
        openObj();
        key("type");
        str(type);
        key("location");
        span(location);
    }

    void raw(const char* kind, Luau::Location location)
    {
        begin("Raw", location);
        key("kind");
        str(kind);
        tokLoc("token", location);
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

    // ---- types: opaque slices until the type layer is modelled ----

    void type(Luau::AstType* node)
    {
        raw("Type", node->location);
    }

    // An explicit pack's location stops short: parseReturnType gives
    // `(A) | B` the span of `(A)` only, and a generic pack default
    // `(A, B)` the span of `(` only. Stretch over the closing paren and the
    // inner types.
    Luau::Location packLocation(Luau::AstTypePack* node)
    {
        Luau::Location location = node->location;
        auto explicitPack = node->as<Luau::AstTypePackExplicit>();
        if (!explicitPack)
            return location;
        if (auto data = cstOf<Luau::CstTypePackExplicit>(node, "explicit type pack"))
            if (has(data->closeParenthesesPosition))
                extend(location, after(data->closeParenthesesPosition, 1));
        extend(location, explicitPack->typeList);
        return location;
    }

    void typePack(Luau::AstTypePack* node)
    {
        raw("TypePack", packLocation(node));
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

    // AstGenericType's location covers the name only; the `= Default` lives
    // in the default's own location.
    void generic(Luau::AstGenericType* node)
    {
        Luau::Location location = node->location;
        if (node->defaultValue)
            extend(location, node->defaultValue->location.end);
        raw("GenericType", location);
    }

    // AstGenericTypePack's location excludes the `...`; the CST node has it.
    void genericPack(Luau::AstGenericTypePack* node)
    {
        Luau::Location location = node->location;
        if (auto data = cstOf<Luau::CstGenericTypePack>(node, "generic type pack"))
            if (has(data->ellipsisPosition))
                extend(location, after(data->ellipsisPosition, 3));
        if (node->defaultValue)
            extend(location, packLocation(node->defaultValue).end);
        raw("GenericTypePack", location);
    }

    // ---- punctuated lists: [{"node": X, "separator": Token}, ...] ----

    template<typename F>
    void punctuated(const char* name, size_t count, Luau::AstArray<Luau::Position> separators, size_t separatorLength, F each)
    {
        key(name);
        openArr();
        for (size_t i = 0; i < count; i++)
        {
            openObj();
            key("node");
            each(i);
            if (i < separators.size && has(separators.data[i]))
                tok("separator", separators.data[i], separatorLength);
            closeObj();
        }
        closeArr();
    }

    void exprs(const char* name, Luau::AstArray<Luau::AstExpr*> list, Luau::AstArray<Luau::Position> commas)
    {
        punctuated(name, list.size, commas, 1, [&](size_t i) {
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
        punctuated(name, list.size, commas, 1, [&](size_t i) {
            localDecl(list.data[i], i < colons.size ? colons.data[i] : Luau::Position::missing());
        });
    }

    void generics(
        Luau::AstArray<Luau::AstGenericType*> types,
        Luau::AstArray<Luau::AstGenericTypePack*> packs,
        Luau::Position open,
        Luau::AstArray<Luau::Position> commas,
        Luau::Position close
    )
    {
        if (types.size == 0 && packs.size == 0)
            return;
        if (!has(open) || !has(close))
        {
            fail("cst writer: generic list without delimiters");
            return;
        }
        key("generics");
        begin("Generics", Luau::Location{open, Luau::Position{close.line, close.column + 1}});
        tok("open", open, 1);
        punctuated("items", types.size + packs.size, commas, 1, [&](size_t i) {
            if (i < types.size)
                generic(types.data[i]);
            else
                genericPack(packs.data[i - types.size]);
        });
        tok("close", close, 1);
        closeObj();
    }

    void typeArguments(Luau::AstArray<Luau::AstTypeOrPack> list, const Luau::CstTypeInstantiation& data)
    {
        if (!has(data.leftArrow1Position) || !has(data.rightArrow2Position))
        {
            fail("cst writer: type argument list without delimiters");
            return;
        }
        key("typeArguments");
        begin(
            "TypeArguments",
            Luau::Location{data.leftArrow1Position, Luau::Position{data.rightArrow2Position.line, data.rightArrow2Position.column + 1}}
        );
        tok("open1", data.leftArrow1Position, 1);
        tok("open2", data.leftArrow2Position, 1);
        punctuated("items", list.size, data.commaPositions, 1, [&](size_t i) {
            typeOrPack(list.data[i]);
        });
        tok("close1", data.rightArrow1Position, 1);
        tok("close2", data.rightArrow2Position, 1);
        closeObj();
    }

    // Attributes stay opaque: one slice per bracketed list, else one per
    // bare attribute.
    void attrs(Luau::AstArray<Luau::AstAttr*> list, Luau::AstArray<Luau::CstAttrList*> lists)
    {
        if (list.size == 0)
            return;
        key("attributes");
        openArr();
        if (lists.size > 0)
        {
            for (size_t i = 0; i < lists.size; i++)
            {
                Luau::Position close = lists.data[i]->closeBracketPosition;
                raw("AttrList", Luau::Location{lists.data[i]->atBracketPosition, Luau::Position{close.line, close.column + 1}});
            }
        }
        else
        {
            for (size_t i = 0; i < list.size; i++)
                raw("Attr", list.data[i]->location);
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
        {
            keyword("vararg", function->varargLocation.begin, "...");
            if (function->varargAnnotation)
            {
                tok("varargColon", data->varargAnnotationColonPosition, 1);
                key("varargAnnotation");
                typePack(function->varargAnnotation);
            }
        }
        tokEnd("close", *function->argLocation, 1);
        if (function->returnAnnotation)
        {
            tok("returnColon", data->returnSpecifierPosition, 1);
            key("returnType");
            typePack(function->returnAnnotation);
        }
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
        {
            begin("LocalRef", n->location);
            key("binding");
            num(binding(n->local));
            tok("name", n->location.begin, strlen(n->local->name.value));
            closeObj();
        }
        else if (auto n = node->as<Luau::AstExprGlobal>())
        {
            begin("Global", n->location);
            tok("name", n->location.begin, strlen(n->name.value));
            closeObj();
        }
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
                span(cursor, expression->location.begin);
                expr(expression);
                cursor = expression->location.end;
            }
            span(cursor, n->location.end);
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
        statBody(node);
        // statBody leaves the node object open so the semicolon lands last.
        if (node->hasSemicolon)
            tokEnd("semicolon", node->location, 1);
        closeObj();
    }

    // A statement the walker does not model: one opaque slice, stopping
    // before the `;` the parser folds into the statement's location.
    void rawStat(const char* kind, Luau::AstStat* node)
    {
        Luau::Location location = node->location;
        if (node->hasSemicolon)
            location.end.column -= 1;
        rawStat(kind, location);
    }

    void rawStat(const char* kind, Luau::Location location)
    {
        begin("Raw", location);
        key("kind");
        str(kind);
        tokLoc("token", location);
    }

    void statBody(Luau::AstStat* node)
    {
        if (auto n = node->as<Luau::AstStatBlock>())
        {
            Luau::CstStatDo* data = cstOf<Luau::CstStatDo>(n, "do block");
            if (!data)
                return;
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
                    return;
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
                return;
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
                return;
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
                return;
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
                return;
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
                return;
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
                return;
            begin("Assign", n->location);
            exprs("variables", n->vars, data->varsCommaPositions);
            tok("equals", data->equalsPosition, 1);
            exprs("values", n->values, data->valuesCommaPositions);
        }
        else if (auto n = node->as<Luau::AstStatCompoundAssign>())
        {
            Luau::CstStatCompoundAssign* data = cstOf<Luau::CstStatCompoundAssign>(n, "compound assignment");
            if (!data)
                return;
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
                return;
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
                return;
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
                return;
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
        else if (node->is<Luau::AstStatTypeFunction>())
            rawStat("StatTypeFunction", node);
        else if (node->is<Luau::AstStatDeclareGlobal>())
            rawStat("StatDeclareGlobal", node);
        else if (auto n = node->as<Luau::AstStatDeclareFunction>())
        {
            // The parser runs a declare function's location on to the next
            // token; its return type pack is where the statement ends.
            Luau::Location location = n->location;
            location.end = n->nameLocation.end;
            extend(location, n->params);
            if (n->retTypes)
                extend(location, packLocation(n->retTypes).end);
            rawStat("StatDeclareFunction", location);
        }
        else if (node->is<Luau::AstStatDeclareExternType>())
            rawStat("StatDeclareExternType", node);
        else
            fail("cst writer: unmodelled statement at line " + std::to_string(node->location.begin.line + 1));
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
        CstWriter writer(parseResult.cstNodeMap);
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
