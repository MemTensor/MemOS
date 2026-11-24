#!/usr/bin/env node
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repairRejectedMessageIds } from '../storage/repair-message-ids.ts';

export function repairMessageIds(args: string[]) {
    let path: string | undefined, batchId: string | undefined, apply = false;
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (key === '--apply' && !apply) apply = true;
        else if (key === '--db' && !path && args[index + 1] && !args[index + 1]!.startsWith('--')) path = args[++index];
        else if (key === '--batch-id' && !batchId && args[index + 1] && !args[index + 1]!.startsWith('--')) batchId = args[++index];
        else throw new Error('用法: repair-message-ids --db <memory.sqlite> [--batch-id <id>] [--apply]；默认只预览');
    }
    if (!path || !statSync(path).isFile()) throw new Error('必须指定已有的 SQLite 文件 --db <memory.sqlite>');
    const db = new DatabaseSync(resolve(path), { readOnly: !apply });
    try { return repairRejectedMessageIds(db, { apply, batchId }); }
    finally { db.close(); }
}

if (import.meta.main) {
    try { process.stdout.write(JSON.stringify(repairMessageIds(process.argv.slice(2))) + '\n'); }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
