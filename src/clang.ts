import { execSync as nodeExecSync, exec as nodeExec } from "child_process";
import { existsSync, rmSync, writeFileSync } from "fs";
import { logInfo, logVerbose } from "./log";

const includeDirArgs: string[] = [];

export function addIncludeDir(dir: string) {
    includeDirArgs.push(`-I${dir}`);
}

export const execSync: typeof nodeExecSync = (command: string, ...args: any): any => {
    logVerbose("execSync", command);
    return nodeExecSync(command, ...args);
};

export async function execLargeJSON(command: string): Promise<any> {
    logVerbose("execLargeJSON", command);
    const tmpFileName = `./exec_tmp_${Date.now()}_${Math.floor(Math.random() * 9999)}`;

    nodeExecSync(command + " > " + tmpFileName);
    const json = await Bun.file(tmpFileName).json();
    rmSync(tmpFileName);

    return json;
}

export async function clangGetAstJson(headerPath: string): Promise<any[]> {
    const cmd = `clang -Xclang -ast-dump=json -fsyntax-only ${includeDirArgs.join(" ")} ` + headerPath;

    logInfo(`clangGetAstJson headerPath="${headerPath}" command="${cmd}"`);

    const result = await execLargeJSON(cmd);
    return result.inner;
}

export function clangCompileAndRunReadOut(code: string) {
    const command = `clang ${includeDirArgs.join(" ")} -x c++ - -o ./generate-bindings_tmp_exec`;
    if (command === "clang -I/Users/work_vk/Desktop/Dev/personal/bun-ffi-gen/include -x c++ - -o ./generate-bindings_tmp_exec") {
        execSync("clang -I/Users/work_vk/Desktop/Dev/personal/bun-ffi-gen/include -x c++ - -E > aaa", {
            input: code,
            stdio: "pipe",
        });
    }
    execSync(command, {
        input: code,
        stdio: "pipe",
    });
    return execSync("./generate-bindings_tmp_exec").toString();
}

export async function clangClean() {
    logInfo("clangClean");

    if (existsSync("./generate-bindings_tmp_exec")) {
        rmSync("./generate-bindings_tmp_exec");
    }
}

export class ClangTypeInfoCache {
    constructor(public readonly cacheFilePath: string) {}

    sizeOf: Record<string, number> = {};
    offsetOf: Record<string, number> = {};

    async save() {
        logInfo("ClangTypeInfoCache.save");
        writeFileSync(this.cacheFilePath + "_sizeof.json", JSON.stringify(this.sizeOf));
        writeFileSync(this.cacheFilePath + "_offsetof.json", JSON.stringify(this.offsetOf));
    }

    static async create(cacheFilePath: string) {
        logInfo(`ClangTypeInfoCache.create cacheFilePath="${cacheFilePath}"`);

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

    logInfo(`clangGetSizeOf "${cTypeName}"`);

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

    logInfo(`clangGetOffsetOf "${cTypeName}"."${fieldName}"`);

    const code = `
        #include "${headerPath}"
        #include <stdio.h>

        int main() {
            printf("[ %lu ]",
                ((size_t)&(reinterpret_cast<${cTypeName}*>(0)->${fieldName}))
            );
            return 0;
        }
    `;

    const result = JSON.parse(clangCompileAndRunReadOut(code))[0];
    if (cache) cache.offsetOf[cacheName] = result;
    return result;
}
