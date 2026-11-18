import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { AdapterProfile } from '../types.ts';
import {installDshConfig,removeDshConfig,hasDshConfig,type DshConfig} from '../deepseek-harness/config.ts';
interface Options {home:string;cwd:string;dshHome?:string}
interface Result {installed:boolean;files:string[];instructions:string[]}
interface Manifest {installed:boolean;files:Array<{path:string;hash:string}>;dshConfig?:DshConfig}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const manifestPath=(p:AdapterProfile,o:Options)=>join(o.home,'.memos-project-memory','adapters',`${p.id}.json`);
async function read(path:string){try{return await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
const directories:Record<string,string>={
 'opencode-v1':'.config/opencode/plugins','opencode-v2':'.config/opencode/plugins','kilo-cli':'.config/kilo/plugin','cline-cli':'.cline/plugins','pi':'.pi/agent/extensions',
 'prime-agent':'.memos-project-memory/prime-agent','deepseek-harness':'.memos-project-memory/deepseek-harness',
};
export async function installNative(profile:AdapterProfile,options:Options):Promise<Result>{
 const suffix=import.meta.url.endsWith('.ts')?'ts':'js';
 const previousText=await read(manifestPath(profile,options));const previous:Manifest=previousText?JSON.parse(previousText):{installed:false,files:[]};
 if(profile.id.startsWith('opencode-')){
  const other=profile.id==='opencode-v1'?'opencode-v2':'opencode-v1';
  if(await read(join(options.home,'.memos-project-memory','adapters',`${other}.json`)))throw new Error('Uninstall the other OpenCode version profile first');
 }
 const entry=new URL(`../${profile.id}/${profile.kind==='rpc'?'rpc/runner':'extension/index'}.${suffix}`,import.meta.url).href;
 const wrapper=join(options.home,directories[profile.id]!,`memos-project-memory.${profile.id==='cline-cli'?'ts':suffix}`);
 const text=profile.id==='deepseek-harness'?`export {name,inject,apply} from ${JSON.stringify(entry)};\n`:profile.kind==='rpc'?`await import(${JSON.stringify(entry)});\n`:`export {default} from ${JSON.stringify(entry)};\n`;
 const dshHome=options.dshHome??join(options.home,'.dsh');
 const skillRoot=profile.id==='deepseek-harness'?join(dshHome,'skills'):join(options.home,profile.skillPath);
 const skill=join(skillRoot,'memos-project-memory','SKILL.md');
 const source=await readFile(fileURLToPath(new URL('../../../skills/project-memory/SKILL.md',import.meta.url)),'utf8');
 const reference=await readFile(fileURLToPath(new URL('../../../skills/project-memory/references/cli-contract.md',import.meta.url)),'utf8');
 const writes=[{path:wrapper,text},{path:skill,text:source},{path:join(dirname(skill),'references','cli-contract.md'),text:reference}];
 for(const item of writes){const current=await read(item.path);if(current!==null&&current!==item.text&&!previous.files.some(file=>file.path===item.path&&file.hash===hash(current)))throw new Error(`Existing file is not owned by MemOS: ${item.path}`);}
 for(const item of writes){await mkdir(dirname(item.path),{recursive:true});await writeFile(item.path,item.text);}
 const instructions=[...(profile.limitations??[]),'请重新启动 Agent，使 MemOS 接入和项目记忆 Skill 生效。'];
 if(profile.id==='prime-agent')instructions.push(`请通过专用入口启动：${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}。每行输入一条 JSON 消息，例如 {"message":"你的问题","inputId":"每条消息的唯一标识"}。请等待当前回复完成后再发送下一条消息。`);
 const manifest:Manifest={installed:true,files:writes.map(item=>({path:item.path,hash:hash(item.text)}))};
 if(profile.id==='deepseek-harness'){
  manifest.dshConfig=await installDshConfig(dshHome,wrapper,previous.dshConfig);
  // Migrate the former launch-only overlay only when it is still installer-owned.
  const legacy=previous.files.find(file=>file.path===join(dirname(wrapper),'memos-project-memory.patch.yml'));
  if(legacy){const content=await read(legacy.path);if(content!==null&&hash(content)===legacy.hash)await rm(legacy.path);}
  instructions.push('接入配置已保存，按原来的方式重新启动 DSH 即可生效。');
 }
 const path=manifestPath(profile,options);await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
 return {installed:true,files:[...writes.map(item=>item.path),...(manifest.dshConfig?[manifest.dshConfig.path]:[])],instructions};
}
export async function uninstallNative(profile:AdapterProfile,options:Options):Promise<Result>{
 const path=manifestPath(profile,options),text=await read(path);if(!text)return {installed:false,files:[],instructions:[]};
 const manifest=JSON.parse(text) as Manifest;const removed:string[]=[];
 if(manifest.dshConfig){await removeDshConfig(manifest.dshConfig);removed.push(manifest.dshConfig.path);}
 for(const file of manifest.files){const current=await read(file.path);if(current!==null&&hash(current)===file.hash){await rm(file.path);removed.push(file.path);}}
 await rm(path);return {installed:false,files:removed,instructions:profile.id==='deepseek-harness'?['请重新启动 DSH，使卸载生效。']:[]};
}

export async function isDshInstalled(profile:AdapterProfile,options:Options):Promise<boolean>{
 const text=await read(manifestPath(profile,options));if(!text)return false;
 const manifest=JSON.parse(text) as Manifest;
 if(!manifest.installed||!manifest.dshConfig||!await hasDshConfig(manifest.dshConfig,options.dshHome??join(options.home,'.dsh')))return false;
 if(!manifest.files.length)return false;
 for(const file of manifest.files){const content=await read(file.path);if(content===null||hash(content)!==file.hash)return false;}
 return true;
}
