import { basename } from "path";
import { POINTER_SIZE } from "./constants";
import { ClangTypeInfoCache, clangGetOffsetOf, clangGetSizeOf } from "./clang";
import { logInfo, logVerbose } from "./log";

export type ParsedClangAstItem =
    | ParsedClangAstItem_Enum
    | ParsedClangAstItem_Alias
    | ParsedClangAstItem_Pointer
    | ParsedClangAstItem_Builtin
    | ParsedClangAstItem_FuncDecl
    | ParsedClangAstItem_FuncPointer
    | ParsedClangAstItem_Struct
    | ParsedClangAstItem_StaticArray
    | ParsedClangAstItem_Union;

export type ParsedClangAstItem_Enum_FieldValue =
    | {
          type: "alias";
          value: string;
      }
    | {
          type: "int";
          value: string;
      }
    | {
          type: "expr";
          value: string;
      };

export type ParsedClangAstItem_Enum = {
    type: "enum";
    size: number;
    name?: string;
    fields: Map<string, ParsedClangAstItem_Enum_FieldValue>;
};

export type ParsedClangAstItem_Alias = {
    type: "alias";
    size: number;
    noEmit?: boolean;
    name?: string;
    aliasTo: ParsedClangAstItem;
};

export type ParsedClangAstItem_LazyAlias = {
    type: "lazy_alias";
    name: string;
    aliasTo: string;
};

export type ParsedClangAstItem_Pointer = {
    type: "pointer";
    size: number;
    name?: string;
    /** undefined means its opaque pointer */
    baseType?: ParsedClangAstItem;
    is_const: boolean;
};

export type ParsedClangAstItem_Builtin = {
    type: "builtin";
    size: number;
    ffiType: string;
    name?: string;
};

export type ParsedClangAstItem_FuncDecl_Arg = {
    name?: string;
    valueType: ParsedClangAstItem;
};

export type ParsedClangAstItem_FuncDecl = {
    type: "func_decl";
    size: number;
    name?: string;
    returnType: ParsedClangAstItem;
    args: ParsedClangAstItem_FuncDecl_Arg[];
};

export type ParsedClangAstItem_Struct_Field = {
    name: string;
    offset: number;
    size: number;
    valueType: ParsedClangAstItem;
};

export type ParsedClangAstItem_Struct = {
    type: "struct";
    size: number;
    name?: string;
    fields: ParsedClangAstItem_Struct_Field[];
};

export type ParsedClangAstItem_StaticArray = {
    type: "static_array";
    length: number;
    size: number;
    name: string;
    itemType: ParsedClangAstItem;
};

export type ParsedClangAstItem_FuncPointer = {
    type: "func_pointer";
    size: number;
    name?: string;
    decl: ParsedClangAstItem_FuncDecl;
};

export type ParsedClangAstItem_Union = {
    type: "union";
    size: number;
    name?: string;
    variants: ParsedClangAstItem_Struct_Field[];
};

export type ParsedClangAstResult = {
    decls: Map<string, ParsedClangAstItem>;
    ptrTypeSymbols: Set<string>;
    funcTypeSymbols: Set<string>;
};

export function parseClangAst(astJson: any[], headerFilePath: string, clangTypeInfoCache: ClangTypeInfoCache): ParsedClangAstResult {
    const headerFileBaseName = basename(headerFilePath);

    const result: ParsedClangAstResult = {
        decls: new Map(),
        ptrTypeSymbols: new Set(),
        funcTypeSymbols: new Set(),
    };

    const lazyAliases = new Map<string, ParsedClangAstItem_LazyAlias>();

    function emitDecl(name: string, item: ParsedClangAstItem) {
        if (result.decls.has(name)) {
            debugger;
            console.warn("overwrite decl name=", name, "item=", item);
        }
        result.decls.set(name, item);

        // resolve lazy aliases
        if (lazyAliases.has(name)) {
            const la = lazyAliases.get(name)!;
            lazyAliases.delete(name);
            emitDecl(la.name, {
                type: "alias",
                size: item.size,
                name: la.name,
                aliasTo: item,
            });
        }
        return item;
    }

    function aliasDecl(aliasTo: ParsedClangAstItem): ParsedClangAstItem {
        if (aliasTo.type === "alias" && aliasTo.noEmit) {
            return aliasTo.aliasTo;
        }
        return {
            type: "alias",
            name: aliasTo.name,
            size: aliasTo.size,
            aliasTo,
        };
    }

    function getDecl(name: string, makeAlias: boolean): ParsedClangAstItem {
        if (!result.decls.has(name)) {
            debugger;
            throw new Error(`decl not found "${name}"`);
        }
        const t = result.decls.get(name)!;
        if (makeAlias) return aliasDecl(t);
        return t;
    }

    function findDecl(pred: Partial<ParsedClangAstItem> | ((item: ParsedClangAstItem) => boolean), makeAlias: boolean) {
        if (typeof pred === "function") {
            for (const t of result.decls.values()) {
                if (pred(t)) {
                    if (makeAlias) return aliasDecl(t);
                    return t;
                }
                continue;
            }
        } else {
            SUKA: for (const t of result.decls.values()) {
                if (pred.type !== undefined && pred.type !== t.type) continue;
                for (const f in pred) {
                    if ((pred as any)[f] !== (t as any)[f]) {
                        continue SUKA;
                    }
                }
                if (makeAlias) return aliasDecl(t);
                return t;
            }
        }

        return undefined;
    }

    const findDeclOrThrow = (...args: Parameters<typeof findDecl>): ParsedClangAstItem => {
        const found = findDecl(...args);
        if (!found) throw new Error(`not found "${JSON.stringify(args)}"`);
        return found;
    };

    function parseUnionDecl(unionDecl: any): Omit<ParsedClangAstItem_Union, "size"> {
        const variants: ParsedClangAstItem_Union["variants"] = [];

        for (const field of unionDecl.inner) {
            const fieldType = extractQualTypeOrPtr(field.type.qualType);
            const fieldName = field.name;
            variants.push({
                name: fieldName,
                size: fieldType.size,
                offset: 0,
                valueType: fieldType,
            });
        }

        return {
            type: "union",
            variants,
        };
    }

    function extractQualTypeOrPtr(qualType: string): ParsedClangAstItem {
        // static array definition
        if (qualType.endsWith("]")) {
            const staticArrayMatch = qualType.trim().match(/^([\w\W]+)\[(\w+)\]$/);
            if (!staticArrayMatch) {
                debugger;
                throw new Error(`failed match static array type "${qualType}"`);
            }
            const baseItemName = staticArrayMatch[1].trim();
            const length = Number(staticArrayMatch[2]);
            const itemType = extractQualTypeOrPtr(baseItemName);
            return {
                type: "static_array",
                name: qualType, // TODO probably bad
                length,
                itemType,
                size: itemType.size * length,
            };
        }

        if (qualType === "const char *") {
            return findDeclOrThrow({ name: "CString" }, false);
        }

        let ptrBaseName = "";
        let is_const = false;
        let isPtr = false;

        const constPtrMatch = qualType.match(/^const (?:struct\s)?(\w+) \*$/);
        const ptrMatch = qualType.match(/^(?:struct\s)?([\w\W\s]+)\s?\*(?:const)?$/);

        if (constPtrMatch) {
            ptrBaseName = constPtrMatch[1];
            is_const = true;
            isPtr = true;
        } else if (ptrMatch) {
            ptrBaseName = ptrMatch[1];
            isPtr = true;
        }

        if (isPtr) {
            const found = findDecl((d) => {
                if (d.type !== "pointer") return false;
                if (d.is_const !== is_const) return false;
                if (d.baseType && d.baseType.name !== ptrBaseName) return false;
                return true;
            }, true);

            return (
                found || {
                    type: "pointer",
                    is_const: true,
                    size: POINTER_SIZE,
                    baseType: findDecl({ name: ptrBaseName }, true),
                }
            );
        }

        return findDeclOrThrow({ name: qualType }, true);
    }

    emitBuiltinTypes(result);

    for (let statementIndex = 0; statementIndex < astJson.length; ++statementIndex) {
        const statement = astJson[statementIndex];

        // if (statement.name === "WGPUQuerySet") debugger;
        if (filterStatement(statement, headerFileBaseName)) continue;

        // enum
        if (statement.kind === "EnumDecl") {
            CDECL_STYLE: if (!statement.name) {
                const nextStatement = astJson[statementIndex + 1];
                if (nextStatement?.kind === "TypedefDecl") {
                    if (nextStatement.range?.begin.line <= statement.loc.line && nextStatement.range?.begin.col <= statement.loc.col) {
                        statement.name = nextStatement.name;
                        ++statementIndex;
                        break CDECL_STYLE;
                    }
                }
                debugger;
                logVerbose(`unknown unnamed EnumDecl ${JSON.stringify(statement)}`);
                continue;
            }

            const enumItem: ParsedClangAstItem_Enum = {
                type: "enum",
                size: 4,
                name: statement.name,
                fields: new Map(),
            };

            let enumValueCounter: undefined | "no-counter" | number = undefined;
            for (const item of statement.inner) {
                const itemName = item.name;
                if (item.kind === "FullComment") continue;
                if (item.inner) {
                    const value = parseEnumValue(item.inner);
                    if (value.type === "int") {
                        enumValueCounter = Number(value.value);
                    } else {
                        enumValueCounter = "no-counter";
                    }
                    enumItem.fields.set(itemName, value);
                } else {
                    if (enumValueCounter === "no-counter") {
                        throw new Error(`enum with mixed implicit & explicit declarations ${JSON.stringify(statement)}`);
                    }
                    if (enumValueCounter === undefined) enumValueCounter = 0;
                    enumItem.fields.set(itemName, {
                        type: "int",
                        value: `${enumValueCounter}`,
                    });
                    enumValueCounter++;
                }
            }

            emitDecl(statement.name, enumItem);

            continue;
        }

        // alias
        if (statement.kind === "TypedefDecl" && statement.type?.typeAliasDeclId) {
            const name = statement.name;

            const aliasTo = statement.type.qualType as string;
            const aliasToType = getDecl(aliasTo, false);
            const aliasItem: ParsedClangAstItem_Alias = {
                type: "alias",
                size: aliasToType.size,
                name,
                aliasTo: aliasToType,
            };

            emitDecl(name, aliasItem);

            continue;
        }

        // struct
        if (statement.kind === "RecordDecl") {
            const name = statement.name;

            if (!statement.inner) {
                continue;
            }

            const structSize = clangGetSizeOf(headerFilePath, name, clangTypeInfoCache);
            const fields: ParsedClangAstItem_Struct_Field[] = [];

            for (let itemIndex = 0; itemIndex < statement.inner.length; ++itemIndex) {
                const item = statement.inner[itemIndex];

                if (item.kind === "FullComment") {
                    continue;
                }

                if (item.tagUsed === "union" && item.kind === "RecordDecl") {
                    const unionFieldType = parseUnionDecl(item);
                    const nextItem = statement.inner[itemIndex + 1];

                    if (!item.name && nextItem?.kind === "FieldDecl" && nextItem.range?.begin.line <= item.loc.line && nextItem.range?.begin.col <= item.loc.col) {
                        item.name = nextItem.name;
                        ++itemIndex;
                    }

                    const fieldOffset = clangGetOffsetOf(headerFilePath, name, item.name, clangTypeInfoCache);
                    const fieldSize = clangGetSizeOf(headerFilePath, `(sizeof ((${name}*)0)->${item.name})`, clangTypeInfoCache);

                    fields.push({
                        name: item.name,
                        size: fieldSize,
                        offset: fieldOffset,
                        valueType: {
                            ...unionFieldType,
                            size: fieldSize,
                        },
                    });
                    continue;
                }

                if (item.kind !== "FieldDecl") {
                    debugger;
                    throw new Error(`unknown field kind in struct ${JSON.stringify(item)}`);
                }

                if (!item.name) {
                    throw new Error(`unknown field in struct ${JSON.stringify(item)}`);
                }

                const fieldName = item.name;
                const fieldOffet = clangGetOffsetOf(headerFilePath, name, fieldName, clangTypeInfoCache);
                const fieldType = extractQualTypeOrPtr(item.type.qualType);

                fields.push({
                    name: fieldName,
                    size: fieldType.size,
                    offset: fieldOffet,
                    valueType: fieldType,
                });

                continue;
            }

            emitDecl(name, {
                type: "struct",
                name,
                size: structSize,
                fields,
            });

            continue;
        }

        // func callback type
        if (
            statement.kind === "TypedefDecl" &&
            statement.inner[0].kind === "PointerType" &&
            statement.inner[0].inner[0].kind === "ParenType" &&
            statement.inner[0].inner[0].inner[0].kind === "FunctionProtoType"
        ) {
            const declName = statement.name;
            const funcProto = statement.inner[0].inner[0].inner[0];

            const returnTypeAst = funcProto.inner[0];
            const argsAst = funcProto.inner.slice(1) as any[];

            function extractType(ast: any): ParsedClangAstItem {
                if (ast.kind === "BuiltinType") {
                    return getDecl(ast.type.qualType, false);
                }

                if (ast.kind === "TypedefType") {
                    if (ast.type.qualType.includes("*")) {
                        debugger;
                    }
                    return getDecl(ast.decl.name, true);
                }

                if (ast.kind === "PointerType") {
                    if (ast.type.qualType === "const char *") {
                        return getDecl("CString", false);
                    }

                    const ptrT = extractQualTypeOrPtr(ast.type.qualType);
                    return ptrT;
                }

                if (ast.kind === "RecordType") {
                    return findDeclOrThrow({ name: ast.decl.name }, true);
                }

                if (ast.kind === "ElaboratedType") {
                    return extractType(ast.inner[0]);
                }

                if (ast.kind === "QualType") {
                    return extractType(ast.inner[0]);
                }

                debugger;
                throw new Error("unknown ast");
            }

            const returnType = extractType(returnTypeAst);
            const args = argsAst.map((x: any, i: number): ParsedClangAstItem_FuncDecl_Arg => {
                const valueType = extractType(x);
                return {
                    name: x.name,
                    valueType,
                };
            });

            // debugger;

            emitDecl(declName, {
                type: "func_pointer",
                name: declName,
                size: POINTER_SIZE,
                decl: {
                    type: "func_decl",
                    name: declName,
                    size: POINTER_SIZE,
                    returnType,
                    args,
                },
            });

            result.ptrTypeSymbols.add(declName);
            result.funcTypeSymbols.add(declName);

            continue;
        }

        // opque pointer type
        if (statement.kind === "TypedefDecl" && statement.type.qualType.endsWith(" *")) {
            // TODO: base type
            const pointerItem: ParsedClangAstItem_Pointer = {
                type: "pointer",
                is_const: false,
                size: POINTER_SIZE,
                name: statement.name,
            };

            // debugger;

            emitDecl(statement.name, pointerItem);

            continue;
        }

        // func decl
        if (statement.kind === "FunctionDecl") {
            const declName = statement.name;

            const returnType = extractQualTypeOrPtr(statement.type.qualType.split("(")[0].trim());
            const args: ParsedClangAstItem_FuncDecl_Arg[] = [];

            if (!!statement.inner) {
                for (const item of statement.inner) {
                    if (item.kind === "ParmVarDecl") {
                        const paramName = item.name;
                        const type = extractQualTypeOrPtr(item.type.qualType);

                        args.push({
                            name: paramName,
                            valueType: type,
                        });
                    } else {
                        debugger;
                    }
                }
            }

            emitDecl(declName, {
                type: "func_decl",
                size: POINTER_SIZE,
                returnType,
                args,
            });

            continue;
        }

        if (statement.kind === "TypedefDecl" && statement.type.qualType.endsWith(" *")) {
            // TODO: base type
            const pointerItem: ParsedClangAstItem_Pointer = {
                type: "pointer",
                is_const: false,
                size: POINTER_SIZE,
                name: statement.name,
            };

            // debugger;

            emitDecl(statement.name, pointerItem);

            continue;
        }

        if (statement.kind === "TypedefDecl") {
            if (statement.type?.qualType) {
                try {
                    const aliasType = extractQualTypeOrPtr(statement.type?.qualType);
                    emitDecl(statement.name, {
                        name: statement.name,
                        type: "alias",
                        size: aliasType.size,
                        aliasTo: aliasType,
                    });
                    continue;
                } catch {}
            }
            if (statement.type?.qualType.startsWith("struct ")) {
                const structAliasOrDecl = statement.type.qualType.substr("struct ".length);
                lazyAliases.set(statement.name, {
                    type: "lazy_alias",
                    aliasTo: structAliasOrDecl,
                    name: statement.name,
                });
                continue;
            }
        }

        logInfo(`unknown statement, skipping`, statement);
        debugger;
    }

    return result;
}

function filterStatement(statement: any, headerFileBaseName: string) {
    if (statement.loc?.includedFrom && !statement.loc.includedFrom.file.endsWith(headerFileBaseName) && !!statement.loc?.includedFrom) {
        return true;
    }

    // filter builtins
    if (statement.kind === "TypedefDecl") {
        if (statement.inner.length === 1 && statement.type.qualType === statement.inner[0].type.qualType && statement.inner[0].kind === "BuiltinType") {
            return true;
        }
        // filter objc shit
        if (statement.name.startsWith("__NS")) {
            return true;
        }

        if (statement.name.startsWith("__builtin_")) {
            return true;
        }

        if (statement.inner[0].kind === "ElaboratedType" && statement.name === statement.inner[0].inner[0].decl.name) {
            return true;
        }
    }

    return false;
}

function parseEnumValue(ast: any): ParsedClangAstItem_Enum_FieldValue {
    if (Array.isArray(ast)) {
        if (ast.length !== 1) {
            debugger;
        }
        return parseEnumValue(ast[0]);
    }

    if (ast.kind === "ConstantExpr") {
        return parseEnumValue(ast.inner);
    }

    if (ast.kind === "IntegerLiteral") {
        return { type: "int", value: ast.value };
    }

    if (ast.kind === "BinaryOperator") {
        const a = parseEnumValue(ast.inner[0]);
        const b = parseEnumValue(ast.inner[1]);

        return { type: "expr", value: `((${a.value}) ${ast.opcode} (${b.value}))` };
    }

    if (ast.kind === "UnaryOperator") {
        const a = parseEnumValue(ast.inner[0]);
        return { type: "expr", value: `(${ast.opcode} ${a.value})` };
    }

    if (ast.kind === "DeclRefExpr") {
        return { type: "alias", value: ast.referencedDecl.name };
    }

    if (ast.kind === "ParenExpr") {
        const a = parseEnumValue(ast.inner[0]);
        return { type: "expr", value: `(${a.value})` };
    }

    throw new Error(`unknown enum value "${JSON.stringify(ast)}"`);
}

function emitBuiltinTypes(out: ParsedClangAstResult) {
    function emitSimple(name: string, size: number, ffiType: string) {
        out.decls.set(name, {
            type: "builtin",
            name,
            size,
            ffiType,
        });
    }

    function emitAlias(name: string, aliasTo: string, noEmit?: "no-emit") {
        const foundAlias = out.decls.get(aliasTo)!;
        out.decls.set(name, {
            type: "alias",
            aliasTo: foundAlias,
            size: foundAlias.size,
            noEmit: !!noEmit,
            name,
        });
    }

    emitSimple("int8_t", 1, "BunFFIType.int8_t");
    emitSimple("int16_t", 2, "BunFFIType.int16_t");
    emitSimple("int32_t", 4, "BunFFIType.int32_t");
    emitSimple("int64_t", 8, "BunFFIType.int64_t");

    emitSimple("uint8_t", 1, "BunFFIType.uint8_t");
    emitSimple("uint16_t", 2, "BunFFIType.uint16_t");
    emitSimple("uint32_t", 4, "BunFFIType.uint32_t");
    emitSimple("uint64_t", 8, "BunFFIType.uint64_t");

    emitSimple("size_t", 8, "BunFFIType.uint64_t");
    emitSimple("ssize_t", 8, "BunFFIType.int64_t");

    emitSimple("void", 0, "BunFFIType.void");

    emitSimple("CString", 8, "BunFFIType.cstring");

    emitSimple("float", 4, "BunFFIType.float");
    emitSimple("double", 8, "BunFFIType.double");

    emitSimple("opaque_pointer", POINTER_SIZE, "BunFFIType.pointer");

    // alias
    emitAlias("char", "int8_t", "no-emit");
    emitAlias("unsigned char", "uint8_t", "no-emit");
    emitAlias("int", "int32_t", "no-emit");
    emitAlias("short", "int16_t", "no-emit");
    emitAlias("unsigned short", "uint16_t", "no-emit");
    emitAlias("unsigned int", "uint32_t", "no-emit");
    emitAlias("long", "int64_t", "no-emit");
    emitAlias("long long", "int64_t", "no-emit");
    emitAlias("unsigned long long", "uint64_t", "no-emit");
    emitAlias("unsigned long", "uint64_t", "no-emit");

    emitAlias("u_int8_t", "uint8_t");
    emitAlias("u_int16_t", "uint16_t");
    emitAlias("u_int32_t", "uint32_t");
    emitAlias("u_int64_t", "uint64_t");

    emitAlias("__int8_t", "int8_t");
    emitAlias("__int16_t", "int16_t");
    emitAlias("__int32_t", "int32_t");
    emitAlias("__int64_t", "int64_t");
}
