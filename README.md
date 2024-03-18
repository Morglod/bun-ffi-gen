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

const wgpuAst = clangGetAstJson(HEADER_PATH);
const clangTypeInfoCache = await ClangTypeInfoCache.create(TYPE_CACHE_PATH);

const result = parseClangAst(wgpuAst, HEADER_PATH, clangTypeInfoCache);
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

await clangTypeInfoCache.save();

codeGen.generateAll(result);

if (codeGen.failedSymbols.size) {
    console.log("ffi failed for:");
    console.log(Array.from(codeGen.failedSymbols));
}

codeGen.writeToFile("./wgpu.ts");
await clangTypeInfoCache.save();
await clangClean();
```
