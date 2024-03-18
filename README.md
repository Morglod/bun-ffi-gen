# bun-ffi-gen

This set of tools used for FFI bindings generation for Bun.  
Parser could be used for anything actually.

Currently latest Bun & TypeScript version should be used.

## Install

```
bun install bun-ffi-gen
```

## Usage

Example of generating bindings for wgpu library.

```ts
import { ClangTypeInfoCache, clangGetAstJson } from "bun-ffi-gen/clang";
import { CodeGen } from "bun-ffi-gen/gen";
import { parseClangAst } from "bun-ffi-gen/parser";

const HEADER_PATH = "./wgpu/wgpu.h";
const TYPE_CACHE_PATH = "./generate-wgpu-bindings_cache";

// get header ast from clang
const wgpuAst = clangGetAstJson(HEADER_PATH);

// create clang types cache (for sizeof / offsetof)
const clangTypeInfoCache = await ClangTypeInfoCache.create(TYPE_CACHE_PATH);

// parse ast
const result = parseClangAst(wgpuAst, HEADER_PATH, clangTypeInfoCache);

// update clang cache
await clangTypeInfoCache.save();

// prepare code generation
const codeGen = new CodeGen({
    funcSymbolsImportLibPathCode(out) {
        out.push(`
            let _LIB_PATH: string = "";

            if (process.platform == "darwin") {
                _LIB_PATH =
                    import.meta.dir +
                    "/../wgpu/libwgpu_native.dylib";
            } else {
                throw new Error("not supported wgpu bindings platform");
            }
        `);

        return "_LIB_PATH";
    },
});

codeGen.generateAll(result);

if (codeGen.failedSymbols.size) {
    console.log("ffi failed for:");
    console.log(Array.from(codeGen.failedSymbols));
}

// write output
codeGen.writeToFile("./wgpu.ts");

// cleanup
await clangTypeInfoCache.save();
await clangClean();
```

## CodeGen options

Passed to constructor, all options are optional.

```ts
{
    // tab width (default 4)
    identWidth: number;

    // generate read_* code (default true)
    readers: boolean;

    // generate write_* code (default true)
    writers: boolean;

    // generate helpers code (default true)
    helpers: boolean;

    // generate types for func declarations (default false)
    // may overlap funcWrappers so dont use it untill you have manual bindings
    funcDeclTypes: boolean;

    // generate wrappers around imported func (default true)
    funcWrappers: boolean;

    // generate dlopen import code (default true)
    funcSymbolsImport: boolean;

    // some code that specifies library path for dlopen
    // overwrites `funcSymbolsImportLibPath`
    // should return variable name that contains library path
    // see example
    funcSymbolsImportLibPathCode: (out: string[]) => string;

    // library path, when you dont use `funcSymbolsImportLibPathCode`
    // may be smth like `import.meta.dir + "/mylib"`
    // bun's suffix will be appended
    funcSymbolsImportLibPath: string;

    // throw when smth fails (default false)
    // when false, prints log
    throwOnErrors: boolean;

    // generate STRUCT_NAME__ffi_size constants (default false)
    structSizes: boolean;

    // generate alloc_* code (default true)
    structAllocs: boolean;
}
```
