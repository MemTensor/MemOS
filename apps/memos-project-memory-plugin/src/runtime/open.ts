import { spawn } from 'node:child_process';
import { ensureService } from '../adapters/_shared/client.ts';
const url = await ensureService();
process.stdout.write(`MemOS 项目记忆 Viewer: ${url}\n`);
const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
child.on('error', () => process.stderr.write('请在浏览器打开上述地址。\n'));
child.unref();
