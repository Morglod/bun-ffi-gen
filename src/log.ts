export enum LogLevel {
    none = 0,
    info = 1,
    verbose = 2,
}

export let logLevel = LogLevel.info;

export function logVerbose(...args: any[]) {
    if (logLevel === LogLevel.verbose) console.log("[verbose]", ...args);
}

export function logInfo(...args: any[]) {
    if (logLevel >= LogLevel.info) console.log("[info]", ...args);
}
