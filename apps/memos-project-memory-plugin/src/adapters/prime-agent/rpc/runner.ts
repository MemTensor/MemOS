/** Internal controlled prompt runner; intentionally absent from public CLI commands. */
import { createInterface } from 'node:readline';
import { PrimeController, PrimeStdio } from './index.ts';
const rpc=new PrimeStdio(process.cwd());
const controller=new PrimeController(rpc,process.cwd());
rpc.onEvent=async event=>{await controller.handleEvent(event);process.stdout.write(`${JSON.stringify(event)}\n`);};
await controller.initialize();
for await (const line of createInterface({input:process.stdin})) {
 try { const input=JSON.parse(line) as {message:string;inputId?:string;images?:unknown[]}; if(typeof input.message!=='string')throw new Error('message is required');await controller.submit(input.message,input.inputId,input.images); }
 catch(error){process.stdout.write(`${JSON.stringify({type:'adapter_error',error:String(error)})}\n`);}
}
await rpc.close();
