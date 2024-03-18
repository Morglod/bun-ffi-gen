import { execSync } from "child_process";
import { existsSync, rmSync, writeFileSync } from "fs";

export function clangGetAstJson(headerPath: string): any[] {
    const cmd = "clang -Xclang -ast-dump=json -fsyntax-only " + headerPath;
    const result = execSync(cmd).toString();
    return JSON.parse(result).inner;
}

export function clangCompileAndRunReadOut(code: string) {
    execSync("clang -x c - -o ./generate-bindings_tmp_exec", {
        input: code,
    });
    return execSync("./generate-bindings_tmp_exec").toString();
}

export async function clangClean() {
    if (existsSync("./generate-bindings_tmp_exec")) {
        rmSync("./generate-bindings_tmp_exec");
    }
}

export class ClangTypeInfoCache {
    constructor(public readonly cacheFilePath: string) {}

    sizeOf: Record<string, number> = {};
    offsetOf: Record<string, number> = {};

    async save() {
        writeFileSync(this.cacheFilePath + "_sizeof.json", JSON.stringify(this.sizeOf));
        writeFileSync(this.cacheFilePath + "_offsetof.json", JSON.stringify(this.offsetOf));
    }

    static async create(cacheFilePath: string) {
        let sizeOf = {};
        if (await Bun.file(cacheFilePath + "_sizeof.json").exists()) {
            sizeOf = await Bun.file(cacheFilePath + "_sizeof.json").json();
        } else {
            console.log("sizeof cache not found, it may take some time");
        }
        let offsetOf = {};
        if (await Bun.file(cacheFilePath + "_offsetof.json").exists()) {
            offsetOf = await Bun.file(cacheFilePath + "_offsetof.json").json();
        } else {
            console.log("offsetof cache not found, it may take some time");
        }

        const c = new ClangTypeInfoCache(cacheFilePath);
        c.sizeOf = sizeOf;
        c.offsetOf = offsetOf;
        return c;
    }
}

export function clangGetSizeOf(headerPath: string, cTypeName: string, cache?: ClangTypeInfoCache): number {
    const cacheName = `${headerPath}_qweqwe_${cTypeName}`;
    if (cache && cacheName in cache.sizeOf) {
        return cache.sizeOf[cacheName];
    }

    const code = `
        #include "${headerPath}"
        #include <stdio.h>

        int main() {
            printf("[ %lu ]", sizeof(${cTypeName}));
            return 0;
        }
    `;

    const result = JSON.parse(clangCompileAndRunReadOut(code))[0];
    if (cache) cache.sizeOf[cacheName] = result;
    return result;
}

export function clangGetOffsetOf(headerPath: string, cTypeName: string, fieldName: string, cache?: ClangTypeInfoCache): number {
    const cacheName = `${headerPath}_qweqwe_${cTypeName}___q123213_${fieldName}`;
    if (cache && cacheName in cache.offsetOf) {
        return cache.offsetOf[cacheName];
    }

    const code = `
        #include "${headerPath}"
        #include <stdio.h>

        int main() {
            printf("[ %lu ]", offsetof(${cTypeName}, ${fieldName}));
            return 0;
        }
    `;

    const result = JSON.parse(clangCompileAndRunReadOut(code))[0];
    if (cache) cache.offsetOf[cacheName] = result;
    return result;
}
