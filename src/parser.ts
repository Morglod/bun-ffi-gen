import { basename } from "path";
import { POINTER_SIZE } from "./constants";
import { ClangTypeInfoCache, clangGetOffsetOf, clangGetSizeOf } from "./clang";

export type ParsedClangAstItem =
    | ParsedClangAstItem_Enum
    | ParsedClangAstItem_Alias
    | ParsedClangAstItem_Pointer
    | ParsedClangAstItem_Builtin
    | ParsedClangAstItem_FuncDecl
    | ParsedClangAstItem_FuncPointer
    | ParsedClangAstItem_Struct;

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
    name?: string;
    aliasTo: ParsedClangAstItem;
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

export type ParsedClangAstItem_FuncPointer = {
    type: "func_pointer";
    size: number;
    name?: string;
    decl: ParsedClangAstItem_FuncDecl;
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

    function emitDecl(name: string, item: ParsedClangAstItem) {
        if (result.decls.has(name)) {
            debugger;
            console.warn("overwrite decl name=", name, "item=", item);
        }
        result.decls.set(name, item);
        return item;
    }

    function aliasDecl(aliasTo: ParsedClangAstItem): ParsedClangAstItem {
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
            throw new Error("decl not found");
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
        if (!found) throw new Error("not found");
        return found;
    };

    function extractQualTypeOrPtr(qualType: string): ParsedClangAstItem {
        if (qualType === "const char *") {
            return findDeclOrThrow({ name: "CString" }, false);
        }

        let ptrBaseName = "";
        let is_const = false;
        let isPtr = false;

        const constPtrMatch = (qualType as string).match(/^const (?:struct\s)?(\w+) \*$/);
        const ptrMatch = (qualType as string).match(/^(?:struct\s)?(\w+) \*$/);

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

    for (const statement of astJson) {
        // if (statement.name === "WGPUQuerySet") debugger;
        if (filterStatement(statement, headerFileBaseName)) continue;

        // enum
        if (statement.kind === "EnumDecl") {
            const enumItem: ParsedClangAstItem_Enum = {
                type: "enum",
                size: 4,
                name: statement.name,
                fields: new Map(),
            };

            for (const item of statement.inner) {
                const itemName = item.name;
                const value = parseEnumValue(item.inner);
                enumItem.fields.set(itemName, value);
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

            for (const item of statement.inner) {
                if (item.kind !== "FieldDecl") {
                    debugger;
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

        // opque pointer type
        if (statement.kind === "TypedefDecl" && statement.type.qualType.startsWith("struct ") && statement.type.qualType.endsWith("Impl *")) {
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
        if (ast.opcode === "<<") {
            const a = parseEnumValue(ast.inner[0]);
            const b = parseEnumValue(ast.inner[1]);

            return { type: "expr", value: `(${a.value} << ${b.value})` };
        }

        if (ast.opcode === "|") {
            const a = parseEnumValue(ast.inner[0]);
            const b = parseEnumValue(ast.inner[1]);

            return { type: "expr", value: `(${a.value} | ${b.value})` };
        }
    }

    if (ast.kind === "DeclRefExpr") {
        return { type: "alias", value: ast.referencedDecl.name };
    }

    throw new Error("unknown enum value");
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
}
