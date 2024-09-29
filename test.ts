import { ClangTypeInfoCache, clangGetAstJson, CodeGen, parseClangAst, clangClean, addIncludeDir } from "./src";
import { LogLevel, setLogLevel } from "./src/log";
import path from "path";

const HEADER_PATH = "./test.h";
const TYPE_CACHE_PATH = "./test-bindings_cache";

setLogLevel(LogLevel.verbose);

// add include dirs for clang
addIncludeDir(path.resolve("my_include_dir"));

// get header ast from clang
const wgpuAst = await clangGetAstJson(HEADER_PATH);

// create clang types cache (for sizeof / offsetof)
const clangTypeInfoCache = await ClangTypeInfoCache.create(TYPE_CACHE_PATH);

// parse ast
const result = parseClangAst(wgpuAst, HEADER_PATH, clangTypeInfoCache);

// update clang cache
await clangTypeInfoCache.save();

// prepare code generation
const codeGen = new CodeGen({
    // see more options below
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
codeGen.writeToFile("./test_out.ts");

// cleanup
await clangTypeInfoCache.save();
await clangClean();
