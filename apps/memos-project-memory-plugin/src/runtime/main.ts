import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../config/config.ts';
import { PluginService } from '../server/service.ts';
import { createLocalServer } from '../server/http.ts';
const directory = defaultDataDir();
mkdirSync(directory, { recursive: true, mode: 0o700 });
const repairLock = join(directory, 'repair.lock');
function checkRepairLock() {
    if (!existsSync(repairLock)) return;
    const pid = Number(readFileSync(repairLock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        process.stderr.write('修复锁尚未写入有效 PID，请稍后重试。\n'); process.exit(1);
    }
    let alive = false;
    try { process.kill(pid, 0); alive = true; }
    catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (alive) { process.stderr.write('Codex 轨迹修复正在进行，请完成后启动服务。\n'); process.exit(1); }
    unlinkSync(repairLock);
}
checkRepairLock();
const lock = join(directory, 'service.lock'), endpoint = join(directory, 'service.json');
const cleanup = () => {
    try { if (JSON.parse(readFileSync(endpoint, 'utf8')).pid === process.pid) unlinkSync(endpoint); } catch { }
    try { if (Number(readFileSync(lock, 'utf8')) === process.pid) unlinkSync(lock); } catch { }
};
if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
        process.kill(pid, 0);
        alive = true;
    }
    catch { }
    if (alive)
        process.exit(0);
    unlinkSync(lock);
}
try {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
}
catch {
    process.exit(0);
}
process.on('exit', cleanup);
// Pair with the repair command's check after acquiring repair.lock.
checkRepairLock();
const service = new PluginService(directory), server = createLocalServer(service);
const timer = setInterval(() => { void service.sync().catch(e => service.store.diagnostic(service.error(e))); }, 1000);
timer.unref();
server.listen(Number(process.env.MEMOS_PM_PORT ?? 0), '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('No local address');
    const url = `http://127.0.0.1:${address.port}`;
    writeFileSync(endpoint, JSON.stringify({ url, pid: process.pid }), { mode: 0o600 });
    process.stdout.write(`MemOS 项目记忆 Viewer: ${url}\n`);
});
let closing = false;
const close = () => {
    if (closing) return;
    closing = true; clearInterval(timer);
    server.close(async () => {
        try { await service.sync(); }
        catch (error) { service.store.diagnostic(service.error(error)); }
        finally { service.close(); cleanup(); process.exit(0); }
    });
};
server.on('error', () => { clearInterval(timer); service.close(); cleanup(); process.exit(1); });
process.on('SIGTERM', close);
process.on('SIGINT', close);
