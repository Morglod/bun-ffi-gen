[![NPM Version](https://badge.fury.io/js/bun-ffi-gen.svg?style=flat)](https://www.npmjs.com/package/bun-ffi-gen)
[![GitHub stars](https://img.shields.io/github/stars/Morglod/bun-ffi-gen.svg?style=social&label=Star)](https://GitHub.com/Morglod/bun-ffi-gen/)

# bun-ffi-gen

This set of tools used for FFI bindings generation for Bun.  
Parser could be used for anything actually.

Generates from .h C file.

Currently latest Bun & TypeScript version should be used.

Will exec `clang` to get ast and type infos, so it should be available in PATH.

Feel free to write an issue with your header file, so I could tweak this package.

Tested on clang13 & bun 1.0.2 (upper versions requests macos update, goodbye bun)

## Install

```
bun install bun-ffi-gen
```

## Usage

Example of generating bindings for wgpu library.

```ts
import { ClangTypeInfoCache, clangGetAstJson, CodeGen, parseClangAst, clangClean, addIncludeDir } from "bun-ffi-gen";
import path from "path";

const HEADER_PATH = "./wgpu/wgpu.h";
const TYPE_CACHE_PATH = "./generate-wgpu-bindings_cache";

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

## Generated bindings

For example we have smth like this in .h file:

```c
typedef struct WGPUSurfaceImpl *WGPUSurface;

typedef struct WGPUSurfaceConfiguration {
    WGPUChainedStruct const * nextInChain;
    WGPUDevice device;
    WGPUTextureFormat format;
    WGPUTextureUsageFlags usage;
    size_t viewFormatCount;
    WGPUTextureFormat const * viewFormats;
    WGPUCompositeAlphaMode alphaMode;
    uint32_t width;
    uint32_t height;
    WGPUPresentMode presentMode;
} WGPUSurfaceConfiguration WGPU_STRUCTURE_ATTRIBUTE;

WGPU_EXPORT void wgpuSurfaceConfigure(WGPUSurface surface, WGPUSurfaceConfiguration const * config) WGPU_FUNCTION_ATTRIBUTE;
```

This will be produced:

```ts
type WGPUSurface = Pointer;
const read_WGPUSurface: (from: BunPointer, offset: number) => Pointer;
const write_WGPUSurface: (x: Pointer | TypedArrayPtr<any>, buffer: Buffer, offset: number) => void;

type WGPUSurfaceConfiguration = {
    nextInChain: ConstPtrT<WGPUChainedStruct>;
    device: WGPUDevice;
    format: WGPUTextureFormat;
    usage: WGPUTextureUsageFlags;
    viewFormatCount: size_t;
    viewFormats: ConstPtrT<WGPUTextureFormat>;
    alphaMode: WGPUCompositeAlphaMode;
    width: uint32_t;
    height: uint32_t;
    presentMode: WGPUPresentMode;
};
function read_WGPUSurfaceConfiguration(from: BunPointer, offset: number): WGPUSurfaceConfiguration;
function write_WGPUSurfaceConfiguration(data, buffer: Buffer, offset: number): void;
function alloc_WGPUSurfaceConfiguration(data, buffer?: Buffer): TypedArrayPtr<WGPUSurfaceConfiguration>;

function wgpuSurfaceConfigure(surface, config): void;

const bunImportedLib = dlopen(...);
```

Then you could do this things:

```ts
wgpuSurfaceConfigure(surface, {
    // all other fields are optional
    format: WGPUTextureFormat.WGPUTextureFormat_R16Sint,
});

// or allocate buffer manually
// by default all non specified fields will be 0
const buf = alloc_WGPUSurfaceConfiguration({});
wgpuSurfaceConfigure(surface, buf);
```

## Helpers

```ts
// allocates zeroed string
alloc_CString(str: string): BunCString;

// in case when you want to set some pointer to null
const NULL;

// when you want to read array of items from binary
// you could get cTypeSize from *__ffi_size constants when set structSizes=true in CodeGen
// itemReader is one of read_* funcs
bunReadArray(from, offset, cTypeSize, itemReader);
```
