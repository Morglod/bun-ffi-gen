import type {
    ParsedClangAstItem,
    ParsedClangAstItem_Alias,
    ParsedClangAstItem_Builtin,
    ParsedClangAstItem_Enum,
    ParsedClangAstItem_FuncDecl,
    ParsedClangAstItem_FuncDecl_Arg,
    ParsedClangAstItem_FuncPointer,
    ParsedClangAstItem_Pointer,
    ParsedClangAstItem_Struct,
    ParsedClangAstResult,
} from "./parser";

const _mapFFITypeToTS = {
    "BunFFIType.int8_t": "number",
    "BunFFIType.int16_t": "number",
    "BunFFIType.int32_t": "number",
    "BunFFIType.int64_t": "bigint | number",

    "BunFFIType.uint8_t": "number",
    "BunFFIType.uint16_t": "number",
    "BunFFIType.uint32_t": "number",
    "BunFFIType.uint64_t": "bigint | number",

    "BunFFIType.void": "void",

    "BunFFIType.cstring": "BunCString",

    "BunFFIType.float": "number",
    "BunFFIType.double": "number",

    "BunFFIType.pointer": "Pointer",
};

const _mapFFITypeToReadFn = {
    "BunFFIType.int8_t": "i8",
    "BunFFIType.int16_t": "i16",
    "BunFFIType.int32_t": "i32",
    "BunFFIType.int64_t": "i64",

    "BunFFIType.uint8_t": "u8",
    "BunFFIType.uint16_t": "u16",
    "BunFFIType.uint32_t": "u32",
    "BunFFIType.uint64_t": "u64",

    "BunFFIType.cstring": "ptr",

    "BunFFIType.float": "f32",
    "BunFFIType.double": "f64",

    "BunFFIType.pointer": "ptr",
};

type GenOpts = {
    identWidth: number;
    readers: boolean;
    writers: boolean;
    helpers: boolean;
    funcDeclTypes: boolean;
    funcWrappers: boolean;
    funcSymbolsImport: boolean;
    funcSymbolsImportLibPathCode: (out: string[]) => string;
    funcSymbolsImportLibPath: string;
    throwOnErrors: boolean;
    structSizes: boolean;
    structAllocs: boolean;
};

function getAstItemNoAliasNoPointer(item: ParsedClangAstItem) {
    if (item.type === "alias") {
        return getAstItemNoAliasNoPointer(item.aliasTo);
    }
    if (item.type === "pointer" && item.baseType) {
        return getAstItemNoAliasNoPointer(item.baseType);
    }
    return item;
}

export class CodeGen {
    out: string[] = [];

    constructor(opts: Partial<GenOpts> = {}) {
        const funcSymbolsImportLibPath = opts.funcSymbolsImportLibPath || `import.meta.dir + "/mylib"`;
        this.opts = {
            identWidth: 4,
            readers: true,
            writers: true,
            helpers: true,
            funcDeclTypes: false,
            throwOnErrors: false,
            funcSymbolsImport: true,
            funcWrappers: true,
            structSizes: false,
            structAllocs: true,
            funcSymbolsImportLibPath,
            funcSymbolsImportLibPathCode: (out) => {
                out.push(`const _LIB_PATH = ${funcSymbolsImportLibPath} + "." + bunSuffix;\n`);
                return "_LIB_PATH";
            },
            ...opts,
        };
    }

    readonly opts: GenOpts;

    failedSymbols = new Set<string>();

    tryDo<T>(f: () => T, params: { message?: string; failedSymbol: string }): T | Error {
        try {
            return f();
        } catch (err) {
            console.warn(`fail for "${params.failedSymbol}"`);
            if (params.message) console.warn(params.message);
            console.warn(err);

            this.failedSymbols.add(params.failedSymbol);

            if (this.opts.throwOnErrors) {
                throw err;
            } else {
                console.warn("not error because opts.throwOnErrors=false");
            }
            return err instanceof Error ? err : new Error(undefined, { cause: err });
        }
    }

    private writeLn(out: string[], str: string, padding: number = 0) {
        out.push(" ".repeat(this.opts.identWidth * padding) + str + "\n");
    }

    private mapFFITypeToTS(ffiType: string): string {
        if (ffiType in _mapFFITypeToTS) {
            return (_mapFFITypeToTS as any)[ffiType];
        }
        throw new Error("unknown ffiType");
    }

    private mapFFITypeToReadFn(ffiType: string): string {
        if (ffiType in _mapFFITypeToReadFn) {
            return (_mapFFITypeToReadFn as any)[ffiType];
        }
        throw new Error("unknown ffiType");
    }

    generateImports(out: string[]) {
        this.writeLn(
            out,
            `import {
                FFIType as BunFFIType,
                JSCallback as BunJSCallback,
                CFunction as BunCFunction,
                dlopen as bunDlopen,
                CString as BunCString,
                ptr as bunPtr,
                type Pointer as BunPointer,
                read as bunRead,
                suffix as bunSuffix,
            } from "bun:ffi";`
        );
    }

    generateHelpers(out: string[]) {
        this.writeLn(
            out,
            `
// prettier-ignore
type _PartialStructArg<T> = {
    [P in keyof T]?:
    T[P] extends (...args: any) => any ? T[P] :
    T[P] extends PtrT<any> ? T[P] :
    T[P] extends ConstPtrT<any> ? T[P] :
    T[P] extends CString ? T[P] :
    T[P] extends object ? _PartialStructArg<T[P]> :
    T[P];
};

const Pointer = BunFFIType.ptr;
type Pointer = BunPointer | null;
type ConstPtrT<T> = (Pointer | TypedArray | Buffer) & { __type: T, __const_ptr: true };
type PtrT<T> = (Pointer | TypedArray | Buffer) & { __type: T, __const_ptr: false };
type TypedArrayPtr<T> = (TypedArray | Buffer) & { __type: T, __const_ptr: any };

export const NULL = null as any as Pointer & { __type: any, __const_ptr: any };

export function bunReadArray<T>(from: Pointer | TypedArrayPtr<T>, offset: number, cTypeSize: number, itemReader: (from: BunPointer, offset: number) => T, length: number | bigint): T[] {
    if (!from) throw new Error('readArray null pointer');
    if (typeof from !== "number") from = bunPtr(from);

    const out = [] as T[];
    for (let i = 0; i < length; ++i) {
        out.push(itemReader(from!, offset + cTypeSize * i));
    }
    return out;
}

export function alloc_CString(str: string) {
    return new BunCString(bunPtr(Buffer.from(str + "\\0")));
}

export function alloc_opaque_pointer(x: Pointer, buffer?: Buffer): TypedArrayPtr<any> {
    if (!buffer) buffer = Buffer.alloc(8);
    buffer.writeBigUint64LE(BigInt((x as any) || 0), 0);
    return buffer as any;
}

`
        );
    }

    getFFIType(d: ParsedClangAstItem): string {
        switch (d.type) {
            case "alias":
                return this.getFFIType(d.aliasTo);
            case "builtin":
                return d.ffiType;
            case "enum":
                return "BunFFIType.int32_t";
            case "func_decl":
                return this.inlineFuncDeclFFIType(d);
            case "func_pointer":
                return "BunFFIType.pointer";
            case "pointer":
                return "BunFFIType.pointer";
            case "struct":
                throw new Error("no ffi type for structs");
            default:
                throw new Error("unknown ast type");
        }
    }

    generateBuiltin(out: string[], name: string, d: ParsedClangAstItem_Builtin) {
        const tsType = this.mapFFITypeToTS(d.ffiType);
        if (tsType === name) return;
        this.writeLn(out, `export type ${name} = ${tsType};`);

        // readers
        if (this.opts.readers) {
            this.writeLn(out, `export function read_${name}(from: BunPointer, offset: number): ${tsType} {`);
            if (d.ffiType === "BunFFIType.cstring") {
                this.writeLn(out, `return new BunCString(bunRead.ptr(from, offset));`, 1);
            } else {
                const readFn = this.mapFFITypeToReadFn(d.ffiType);
                this.writeLn(out, `return bunRead.${readFn}(from, offset);`, 1);
            }
            this.writeLn(out, `}`);
        }

        // writers
        if (this.opts.writers) {
            let argType = tsType;
            if (name === "opaque_pointer") {
                argType += " | TypedArrayPtr<any>";
            }

            this.writeLn(out, `export function write_${name}(x: ${argType}, buffer: Buffer, offset: number) {`);
            switch (d.ffiType) {
                case "BunFFIType.int8_t":
                    this.writeLn(out, `buffer.writeInt8(x || 0, offset);`, 1);
                    break;
                case "BunFFIType.int16_t":
                    this.writeLn(out, `buffer.writeInt16LE(x || 0, offset);`, 1);
                    break;
                case "BunFFIType.int32_t":
                    this.writeLn(out, `buffer.writeInt32LE(x || 0, offset);`, 1);
                    break;
                case "BunFFIType.int64_t":
                    this.writeLn(out, `buffer.writeBigInt64LE(BigInt(x || 0), offset);`, 1);
                    break;
                case "BunFFIType.uint8_t":
                    this.writeLn(out, `buffer.writeUint8(x || 0, offset);`, 1);
                    break;
                case "BunFFIType.uint16_t":
                    this.writeLn(out, `buffer.writeUint16LE(x || 0, offset);`, 1);
                    break;
                case "BunFFIType.uint32_t":
                    this.writeLn(out, `buffer.writeUint32LE(x || 0, offset);`, 1);
                    break;
                case "BunFFIType.uint64_t":
                    this.writeLn(out, `buffer.writeBigUint64LE(BigInt(x || 0), offset);`, 1);
                    break;
                case "BunFFIType.string":
                    this.writeLn(out, `buffer.writeBigUint64LE(BigInt(x.ptr), offset);`, 1);
                    break;
                case "BunFFIType.float":
                    this.writeLn(out, `buffer.writeFloatLE(x, offset);`, 1);
                    break;
                case "BunFFIType.double":
                    this.writeLn(out, `buffer.writeDoubleLE(x, offset);`, 1);
                    break;
                case "BunFFIType.pointer":
                    this.writeLn(out, `if (x && typeof x === "object" && "BYTES_PER_ELEMENT" in x) x = bunPtr(x);`, 1);
                    this.writeLn(out, `buffer.writeBigUint64LE(BigInt(x || 0), offset);`, 1);
                    break;
                case "BunFFIType.cstring":
                    this.writeLn(out, `buffer.writeBigUint64LE(BigInt(x.ptr || 0), offset);`, 1);
                    break;
                default:
                    throw new Error("unknown ffi type");
            }
            this.writeLn(out, `}`);
        }
    }

    generateEnum(out: string[], name: string, d: ParsedClangAstItem_Enum) {
        this.writeLn(out, `export enum ${name} {`);
        for (const [fieldName, f] of d.fields) {
            this.writeLn(out, `${fieldName} = ${f.value},`, 1);
        }
        this.writeLn(out, `}`);

        if (this.opts.readers) {
            this.writeLn(out, `export function read_${name}(from: BunPointer, offset: number): ${name} {`);
            this.writeLn(out, `return bunRead.i32(from, offset) as ${name};`, 1);
            this.writeLn(out, `}`);
        }
        if (this.opts.writers) {
            this.writeLn(out, `export function write_${name}(x: ${name}, buffer: Buffer, offset: number) {`);
            this.writeLn(out, `buffer.writeInt32LE(x as number, offset);`, 1);
            this.writeLn(out, `}`);
        }
    }

    generateAlias(out: string[], name: string, d: ParsedClangAstItem_Alias) {
        this.writeLn(out, `export type ${name} = ${d.aliasTo.name};`);

        if (this.opts.readers) {
            this.writeLn(out, `export const read_${name} = read_${d.aliasTo.name};`);
        }
        if (this.opts.writers) {
            this.writeLn(out, `export const write_${name} = write_${d.aliasTo.name};`);
        }
    }

    generatePointer(out: string[], name: string, d: ParsedClangAstItem_Pointer) {
        this.writeLn(out, `export type ${name} = ${this.inlineTsPointerType(d)};`);

        // TODO: is it right?
        if (this.opts.readers) {
            this.writeLn(out, `export const read_${name} = read_opaque_pointer;`);
        }
        if (this.opts.writers) {
            this.writeLn(out, `export const write_${name} = write_opaque_pointer;`);
        }
    }

    generateFuncPointer(out: string[], name: string, d: ParsedClangAstItem_FuncPointer) {
        this.writeLn(out, `export type ${name} = ${this.inlineFuncDeclType(d.decl)};`);

        if (this.opts.readers) {
            const funcDeclCode = this.tryDo(() => this.inlineFuncDeclFFIType(d.decl), { failedSymbol: `read_${name}` });

            if (funcDeclCode instanceof Error) {
            } else {
                this.writeLn(out, `export function read_${name}(from: BunPointer, offset: number): ${name} {`);
                this.writeLn(out, `const ptr = bunRead.ptr(from, offset);`, 1);
                this.writeLn(out, `return BunCFunction({`, 1);
                this.writeLn(out, `ptr,`, 2);
                this.writeLn(out, `...${funcDeclCode},`, 2);
                this.writeLn(out, `}) as any;`, 1);
                this.writeLn(out, `}`);
            }
        }

        if (this.opts.writers) {
            const funcDeclCode = this.tryDo(() => this.inlineFuncDeclFFIType(d.decl), { failedSymbol: `write_${name}` });

            if (funcDeclCode instanceof Error) {
            } else {
                this.writeLn(out, `export function write_${name}(x: ${name}, buffer: Buffer, offset: number) {`);
                this.writeLn(out, `const func = new BunJSCallback(x, ${funcDeclCode});`, 1);
                this.writeLn(out, `write_opaque_pointer(func.ptr, buffer, offset);`, 1);
                this.writeLn(out, `}`);
            }
        }
    }

    inlineFuncDeclFFIType(d: ParsedClangAstItem_FuncDecl) {
        return `{
            returns: ${this.getFFIType(d.returnType)},
            args: [ ${d.args.map((x) => this.getFFIType(x.valueType))} ],
        }`;
    }

    inlineTsPointerType(d: ParsedClangAstItem_Pointer) {
        if (!d.baseType) {
            // opaque pointer
            return "Pointer";
        }

        const innerT = this.inlineTsType(d.baseType);
        if (d.is_const) {
            return `ConstPtrT<${innerT}>`;
        } else {
            return `PtrT<${innerT}>`;
        }
    }

    inlineTsType(d: ParsedClangAstItem): string {
        if (d.name) return d.name;
        switch (d.type) {
            case "alias":
                return this.inlineTsType(d.aliasTo);
            case "builtin":
                return d.name || this.mapFFITypeToTS(d.ffiType);
            case "func_decl":
                return this.inlineFuncDeclType(d);
            case "func_pointer":
                return this.inlineFuncDeclType(d.decl);
            case "pointer":
                return this.inlineTsPointerType(d);
            case "struct":
            case "enum":
                throw new Error("no ts type found");
            default:
                throw new Error("unknown ast type");
        }
    }

    inlineFuncDeclType(d: ParsedClangAstItem_FuncDecl) {
        const returnType = this.inlineTsType(d.returnType);
        const args = d.args.map((x, i) => `${x.name || "arg" + i}: ${this.inlineTsType(x.valueType)}`).join(", ");
        return `(${args}) => ${returnType}`;
    }

    generateFuncDecl(out: string[], name: string, d: ParsedClangAstItem_FuncDecl) {
        if (this.opts.funcDeclTypes) {
            this.writeLn(out, `export type ${name} = ${this.inlineFuncDeclType(d)};`);
        }

        // func wrapper is last step
    }

    generateStruct(out: string[], name: string, d: ParsedClangAstItem_Struct) {
        this.writeLn(out, `export type ${name} = {`);
        for (const f of d.fields) {
            this.writeLn(out, `${f.name}: ${this.inlineTsType(f.valueType)},`, 1);
        }
        this.writeLn(out, `};`);

        if (this.opts.readers) {
            this.writeLn(out, `export function read_${name}(from: BunPointer, offset: number): ${name} {`);
            this.writeLn(out, `return {`, 1);
            for (const f of d.fields) {
                if (f.valueType.type === "pointer") {
                    this.writeLn(out, `${f.name}: read_opaque_pointer(from, offset + ${f.offset}) as any,`, 2);
                } else {
                    if (!f.valueType.name) {
                        throw new Error("bad value type");
                    }
                    this.writeLn(out, `${f.name}: read_${f.valueType.name}(from, offset + ${f.offset}),`, 2);
                }
            }
            this.writeLn(out, `};`, 1);
            this.writeLn(out, `}`);
        }

        if (this.opts.writers) {
            this.writeLn(out, `export function write_${name}(x: ${name} | _PartialStructArg<${name}>, buffer: Buffer, offset: number) {`);
            for (const f of d.fields) {
                if (f.valueType.type === "pointer") {
                    this.writeLn(out, `x.${f.name} !== undefined && write_opaque_pointer(x.${f.name}, buffer, offset + ${f.offset});`, 2);
                } else {
                    if (!f.valueType.name) {
                        throw new Error("bad value type");
                    }
                    this.writeLn(out, `x.${f.name} !== undefined && write_${f.valueType.name}(x.${f.name}, buffer, offset + ${f.offset});`, 1);
                }
            }
            this.writeLn(out, `}`);
        }

        if (this.opts.structSizes) {
            this.writeLn(out, `export const ${name}__ffi_size = ${d.size};`);
        }

        if (this.opts.structAllocs) {
            this.writeLn(out, `export function alloc_${name}(x: ${name} | _PartialStructArg<${name}>, buffer?: Buffer): TypedArrayPtr<${name}> {`);
            this.writeLn(out, `if (!buffer) buffer = Buffer.alloc(${d.size});`, 1);
            this.writeLn(out, `write_${name}(x, buffer, 0);`, 1);
            this.writeLn(out, `return buffer as any;`, 1);
            this.writeLn(out, `}`);
        }
    }

    generateFuncSymbolImports(parsed: ParsedClangAstResult, out: string[]) {
        const libPathVarName = this.opts.funcSymbolsImportLibPathCode(out);
        this.writeLn(out, `export const bunImportedLib = bunDlopen(${libPathVarName}, {`);
        for (const [dname, d] of parsed.decls) {
            if (d.type !== "func_decl") continue;
            const funcDeclCode = this.tryDo(() => this.inlineFuncDeclFFIType(d), { failedSymbol: dname, message: `failed generate symbol` });
            if (funcDeclCode instanceof Error) {
                continue;
            }
            this.writeLn(out, `${dname}: ${funcDeclCode},`, 1);
        }
        this.writeLn(out, `});`);
    }

    generateFuncWrapper(out: string[], name: string, d: ParsedClangAstItem_FuncDecl) {
        const returnTypeFFI = this.tryDo(() => this.getFFIType(d.returnType), {
            failedSymbol: name,
            message: `failed generate wrapper`,
        });
        if (returnTypeFFI instanceof Error) {
            return;
        }
        const returnTypeTs = this.mapFFITypeToTS(returnTypeFFI);

        const argNameIn = (x: ParsedClangAstItem_FuncDecl_Arg, i: number) => x.name || "arg" + i;
        const argNameOut = (x: ParsedClangAstItem_FuncDecl_Arg, i: number) => "_" + (x.name || "arg" + i);

        let isDirectInOutArgs = true;

        const args = this.tryDo(
            () =>
                d.args.map((x, i) => {
                    const inArgName = argNameIn(x, i);
                    const outArgName = argNameOut(x, i);
                    const outFFIType = this.getFFIType(x.valueType);
                    let declTsType = this.inlineTsType(x.valueType);
                    let callArgName = inArgName;
                    const transformCode = [] as string[];

                    if (outFFIType === "BunFFIType.pointer") {
                        const astItemType = getAstItemNoAliasNoPointer(x.valueType);
                        if (astItemType.type === "func_pointer") {
                            const funcDeclCode = this.inlineFuncDeclFFIType(astItemType.decl);
                            this.writeLn(transformCode, `const ${outArgName} = new BunJSCallback(${inArgName}, ${funcDeclCode}).ptr;`, 2);
                            isDirectInOutArgs = false;
                            callArgName = outArgName;
                        } else if (astItemType.type === "struct") {
                            declTsType += ` | _PartialStructArg<${astItemType.name}>`;
                            this.writeLn(transformCode, `let ${outArgName}: Pointer | Buffer = ${inArgName} as any;`, 2);
                            this.writeLn(transformCode, `if (${inArgName} && typeof ${inArgName} === "object" && !("BYTES_PER_ELEMENT" in ${inArgName})) {`, 2);
                            this.writeLn(transformCode, `${outArgName} = Buffer.alloc(${astItemType.size});`, 3);
                            this.writeLn(transformCode, `write_${astItemType.name}(${inArgName}, ${outArgName}, 0);`, 3);
                            this.writeLn(transformCode, `}`, 2);
                            isDirectInOutArgs = false;
                            callArgName = outArgName;
                        } else {
                            declTsType += ` | TypedArrayPtr<any>`;
                            callArgName = inArgName;
                        }
                    } else {
                        callArgName = inArgName;
                    }

                    return {
                        transformCode,
                        inArgName,
                        declTsType,
                        callArgName,
                    };
                }),
            {
                failedSymbol: name,
                message: `failed generate wrapper for ${name}`,
            }
        );
        if (args instanceof Error) {
            return;
        }

        const argsDeclCode = args.map((x) => `${x.inArgName}: ${x.declTsType}`).join(", ");

        if (isDirectInOutArgs) {
            this.writeLn(out, `export const ${name} = bunImportedLib.symbols.${name} as (${argsDeclCode}) => ${returnTypeTs};`);
        } else {
            this.writeLn(out, `export function ${name}(${argsDeclCode}): ${returnTypeTs} {`);

            for (const arg of args) {
                if (arg.transformCode.length) {
                    out.push(...arg.transformCode);
                }
            }

            this.writeLn(out, `return bunImportedLib.symbols.${name}(${args.map((x) => x.callArgName).join(", ")});`, 1);
            this.writeLn(out, `};`);
        }
    }

    generateAll(parsed: ParsedClangAstResult, out: string[] = this.out) {
        this.generateImports(out);
        if (this.opts.helpers) this.generateHelpers(out);

        for (const [dname, d] of parsed.decls) {
            switch (d.type) {
                case "builtin":
                    this.generateBuiltin(out, dname, d);
                    break;

                case "enum":
                    this.generateEnum(out, dname, d);
                    break;

                case "alias":
                    this.generateAlias(out, dname, d);
                    break;

                case "pointer":
                    this.generatePointer(out, dname, d);
                    break;

                case "func_decl":
                    this.generateFuncDecl(out, dname, d);
                    break;

                case "func_pointer":
                    this.generateFuncPointer(out, dname, d);
                    break;

                case "struct":
                    this.generateStruct(out, dname, d);
                    break;

                default:
                    throw new Error(`unknown decl type`);
            }
        }

        if (this.opts.funcSymbolsImport) {
            this.generateFuncSymbolImports(parsed, out);
        }
        if (this.opts.funcWrappers) {
            for (const [dname, d] of parsed.decls) {
                if (d.type !== "func_decl") continue;
                this.generateFuncWrapper(out, dname, d);
            }
        }
    }

    async writeToFile(filePath: string) {
        const f = Bun.file(filePath);
        const w = f.writer();
        for (const l of this.out) {
            w.write(l);
        }
        w.end();
    }
}
