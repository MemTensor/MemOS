import { access, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { profiles, getProfile } from './registry.ts';
import { hookEvents } from './_shared/hooks.ts';
import { object } from './_shared/transcript.ts';
import type { AdapterProfile } from './types.ts';
const run=promisify(execFile);
const marker='memos-project-memory';
interface Options { home?:string; cwd?:string; dshHome?:string }
interface Manifest { configPath?:string; entries?:Record<string,unknown>; skillFile:string; skillHash:string; skillFiles?:Array<{path:string;hash:string}>; previousEnabled?:unknown; installedAt:string }
export interface InstallResult { installed:boolean; files:string[]; instructions:string[] }
const digest=(value:string):string=>createHash('sha256').update(value).digest('hex');
const quote=(value:string):string=>`'${value.replace(/'/g,"'\\''")}'`;
async function exists(path:string):Promise<boolean>{try{await access(path);return true;}catch{return false;}}
async function json(path:string):Promise<Record<string,unknown>>{try{return object(JSON.parse(await readFile(path,'utf8')));}catch(error){if(object(error).code==='ENOENT')return {};throw error;}}
async function save(path:string,value:unknown):Promise<void>{await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');}
function targetPath(profile:AdapterProfile,relative:string,options:Options):string{
 const home=options.home ?? homedir();
 if(!options.home){
  const overrides:Record<string,[string,string]>={'codex-cli':['CODEX_HOME','.codex'],'copilot-cli':['COPILOT_HOME','.copilot'],'kimi-code':['KIMI_CODE_HOME','.kimi-code'],'workbuddy':['WORKBUDDY_CONFIG_DIR','.workbuddy'],'codebuddy-cli':['CODEBUDDY_CONFIG_DIR','.codebuddy']};
  const override=overrides[profile.id];
  if(override&&process.env[override[0]]&&relative.startsWith(override[1]+'/'))return join(process.env[override[0]]!,relative.slice(override[1].length+1));
 }
 return join(home,relative);
}
function manifestPath(profile:AdapterProfile,home:string):string{return join(home,'.memos-project-memory','adapters',`${profile.id}.json`);}
/** Only verified installer files establish tool names; package files establish exact paths. */
export function installedSkills(agentType:string,home=homedir()):ReadonlySet<string>{
 const owned=new Set<string>();const profile=profiles.find(profile=>profile.id===agentType);
 if(!profile)return owned;
 let manifest:Record<string,unknown>={};
 try{manifest=object(JSON.parse(readFileSync(manifestPath(profile,home),'utf8')));}catch(error){if(object(error).code!=='ENOENT')throw error;}
 const files=[...(Array.isArray(manifest.skillFiles)?manifest.skillFiles:[]),...(Array.isArray(manifest.files)?manifest.files:[])];
 if(typeof manifest.skillFile==='string')files.push({path:manifest.skillFile,hash:manifest.skillHash});
 if(manifest.installed!==false)for(const value of files){
  const file=object(value);
  if(typeof file.path!=='string'||!isAbsolute(file.path)||basename(file.path)!=='SKILL.md'||typeof file.hash!=='string')continue;
  try{
   if(digest(readFileSync(file.path,'utf8'))!==file.hash)continue;
   owned.add(resolve(file.path));owned.add(realpathSync(file.path));owned.add(basename(dirname(file.path)));
  }catch(error){if(object(error).code!=='ENOENT')throw error;}
 }
 const root=fileURLToPath(new URL('../../skills/',import.meta.url));
 for(const entry of readdirSync(root,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const path=join(root,entry.name,'SKILL.md');
  try{owned.add(realpathSync(path));owned.add(resolve(path));}catch(error){if(object(error).code!=='ENOENT')throw error;}
 }
 return owned;
}
function eventMap(config:Record<string,unknown>,id:string,create:boolean):Record<string,unknown>{
 if(id==='factory-droid')return config;
 if(id==='antigravity-cli'){if(create)config[marker]??={};return object(config[marker]);}
 if(create)config.hooks??={};
 const hooks=object(config.hooks);
 if(id==='zcode'){if(create)hooks.events??={};return object(hooks.events);}
 return hooks;
}
export async function hookNodeExecutable(executable=process.execPath):Promise<string>{
 const match=executable.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
 if(!match)return executable;
 // Keep Homebrew's stable link instead of resolving it back into a versioned Cellar path.
 const current=await realpath(executable);
 for(const candidate of [join(match[1]!,'opt',match[2]!,'bin/node'),join(match[1]!,'bin/node')]){
  try{if(await realpath(candidate)===current)return candidate;}catch{/* Stable link absent. */}
 }
 return executable;
}
async function handlers(profile:AdapterProfile):Promise<Record<string,unknown>>{
 const executable=await hookNodeExecutable();
 const suffix=import.meta.url.endsWith('.ts')?'ts':'js';
 const entry=fileURLToPath(new URL(`./${profile.id}/index.${suffix}`,import.meta.url));
 return Object.fromEntries((hookEvents[profile.id] ?? []).map(event=>{
  const command=`${quote(executable)} ${quote(entry)} ${quote(event)}`;
  const handler={type:'command',command,timeout:profile.sessionStartBlocking&&event==='SessionStart'?20:10};
  if(profile.id==='cursor-cli')return [event,{command}];
  if(profile.id==='copilot-cli')return [event,{type:'command',exec:executable,args:[entry,event],timeoutSec:10}];
  if(profile.id==='zcode')return [event,{hooks:[{type:'process',command:executable,args:[entry,event],timeoutMs:10000}]}];
  if(profile.id==='antigravity-cli'&&!event.includes('ToolUse'))return [event,handler];
  return [event,{hooks:[handler]}];
 }));
}
function kimiBlock(entries:Record<string,unknown>):string{
 return `# ${marker}:start\n`+Object.entries(entries).map(([event,value])=>{
  const command=String(object((object(value).hooks as unknown[])[0]).command);
  return `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = 10\n`;
 }).join('\n')+`# ${marker}:end\n`;
}
function stripKimi(text:string):string{return text.replace(new RegExp(`(?:\\n)?# ${marker}:start\\n[\\s\\S]*?# ${marker}:end\\n?`,'g'),'');}
async function installSkills(profile:AdapterProfile,options:Options):Promise<Array<{path:string;hash:string}>>{
 const previous=await json(manifestPath(profile,options.home??homedir()));
 const owned=Array.isArray(previous.skillFiles)?previous.skillFiles.map(object):[];
 if(typeof previous.skillFile==='string')owned.push({path:previous.skillFile,hash:previous.skillHash});
 const writes:Array<{path:string;text:string}>=[];
 for(const [sourceName,installedName] of [['project-memory',marker],['create-project-space','memos-create-project-space'],['bind-project-space','memos-bind-project-space'],['list-project-spaces','memos-list-project-spaces'],['unbind-project-space','memos-unbind-project-space']]){
  const source=fileURLToPath(new URL(`../../skills/${sourceName}/`,import.meta.url));
  const directory=targetPath(profile,join(profile.skillPath,installedName!),options);
  for(const relative of ['SKILL.md','references/cli-contract.md']){
   let text=await readFile(join(source,relative),'utf8');
   if(relative==='SKILL.md'&&['project-memory','create-project-space'].includes(sourceName!)&&['cursor-cli','grok-build'].includes(profile.id)){
    text+=sourceName==='project-memory'
     ? "\n## Host-provided search identity\n\nUse the command below on this host. Before the Shell tool executes, the adapter supplies the current session and user-turn variables through the host's native preToolUse input rewriting. These values come from the local service, not from historical identifiers, directories, or shared files. Do not replace them with literal IDs from an earlier turn.\n\n```sh\nmemos-pm search --session-id \"$MEMOS_PM_SESSION_ID\" --conversation-id \"$MEMOS_PM_CONVERSATION_ID\" --query \"a specific question\"\n```\n"
     : "\n## Host-provided creation identity\n\nUse the command below on this host. The adapter supplies the current-turn variable before Shell execution, including for an unbound project. Do not set this variable yourself or replace it with a historical identifier.\n\n```sh\nmemos-pm create --context \"$MEMOS_PM_CREATE_CONTEXT\" --name \"<user-confirmed name>\" --domain \"<user-confirmed domain>\"\n```\n";
   }
   writes.push({path:join(directory,relative),text});
  }
 }
 // Check every file before writing any Skill, so a user edit cannot leave a partial update.
 for(const item of writes){
  if(!await exists(item.path))continue;
  const current=await readFile(item.path,'utf8');
  if(current!==item.text&&!owned.some(file=>file.path===item.path&&file.hash===digest(current)))throw new Error(`Skill already exists and is not owned by this installer: ${item.path}`);
 }
 for(const item of writes){await mkdir(dirname(item.path),{recursive:true});await writeFile(item.path,item.text);}
 return writes.map(item=>({path:item.path,hash:digest(item.text)}));
}

export async function installAdapter(id:string,options:Options={}):Promise<InstallResult>{
 const profile=getProfile(id);const home=options.home??homedir();const cwd=options.cwd??process.cwd();
 if(id==='prime-agent')return (await import('./prime-agent/install.ts')).installPrime(options);
 if(profile.kind!=='hook'){
  const {installNative}=await import('./_shared/native-install.ts');return installNative(profile,{home,cwd,dshHome:options.dshHome??(options.home?undefined:process.env.DSH_HOME)});
 }
 const skills=await installSkills(profile,options);const skill=skills[0]!;const entries=await handlers(profile);const files=skills.map(file=>file.path);
 const manifest:Manifest={skillFile:skill.path,skillHash:skill.hash,skillFiles:skills,installedAt:new Date().toISOString()};
 if(profile.configPath){
  const path=targetPath(profile,profile.configPath,options);manifest.configPath=path;files.push(path);
  if(id==='kimi-code'){
   let text='';try{text=await readFile(path,'utf8');}catch(error){if(object(error).code!=='ENOENT')throw error;}
   await mkdir(dirname(path),{recursive:true});await writeFile(path,stripKimi(text)+'\n'+kimiBlock(entries));
  }else{
   const config=await json(path);const map=eventMap(config,id,true);
   const previous=await json(manifestPath(profile,home));
   for(const [event,entry]of Object.entries(entries)){
    const existing=map[event];if(existing!==undefined&&!Array.isArray(existing))throw new Error(`Invalid ${event} hook list in ${path}`);
    const previousEntry=object(previous.entries)[event];
    map[event]=[...(Array.isArray(existing)?existing:[]).filter(value=>JSON.stringify(value)!==JSON.stringify(previousEntry)&&JSON.stringify(value)!==JSON.stringify(entry)),entry];
   }
   if(['cursor-cli','copilot-cli','trae'].includes(id))config.version??=1;
   if(id==='zcode'){const hooks=object(config.hooks);manifest.previousEnabled=Object.hasOwn(previous,'previousEnabled')?previous.previousEnabled:hooks.enabled;hooks.enabled=true;}
   manifest.entries=entries;await save(path,config);
  }
 }
 await save(manifestPath(profile,home),manifest);
 return {installed:true,files,instructions:[...(profile.limitations??[]),'请新建 Agent 会话或重新加载接入配置。如果宿主提示权限确认，请核对 MemOS 接入项并按提示授权。']};
}
export async function uninstallAdapter(id:string,options:Options={}):Promise<InstallResult>{
 const profile=getProfile(id);const home=options.home??homedir();const cwd=options.cwd??process.cwd();
 if(profile.kind!=='hook'){const {uninstallNative}=await import('./_shared/native-install.ts');return uninstallNative(profile,{home,cwd,dshHome:options.dshHome??(options.home?undefined:process.env.DSH_HOME)});}
 const path=manifestPath(profile,home);const manifest=await json(path);const files:string[]=[];
 if(typeof manifest.configPath==='string'&&await exists(manifest.configPath)){
  const configPath=manifest.configPath;
  if(id==='kimi-code')await writeFile(configPath,stripKimi(await readFile(configPath,'utf8')));
  else{
   const config=await json(configPath);const map=eventMap(config,id,false);
   for(const[event,entry]of Object.entries(object(manifest.entries))){
    if(Array.isArray(map[event])){map[event]=(map[event] as unknown[]).filter(value=>JSON.stringify(value)!==JSON.stringify(entry));if(!(map[event] as unknown[]).length)delete map[event];}
   }
   if(id==='antigravity-cli'&&!Object.keys(map).length)delete config[marker];
   if(id==='zcode'&&object(config.hooks).enabled===true){if(Object.hasOwn(manifest,'previousEnabled'))object(config.hooks).enabled=manifest.previousEnabled;else delete object(config.hooks).enabled;}
   await save(configPath,config);
  }
  files.push(configPath);
 }
 const skills=Array.isArray(manifest.skillFiles)?manifest.skillFiles.map(object)
  : typeof manifest.skillFile==='string'?[{path:manifest.skillFile,hash:manifest.skillHash}]:[];
 // Codex and dcode share official Skill roots; leave files while another profile owns them.
 const others=await Promise.all(profiles.filter(p=>p.id!==id).map(p=>json(manifestPath(p,home))));
 for(const skill of skills){
  if(typeof skill.path!=='string'||!await exists(skill.path)||digest(await readFile(skill.path,'utf8'))!==skill.hash)continue;
  const shared=others.some(other=>other.skillFile===skill.path
   || [other.skillFiles,other.files].some(list=>Array.isArray(list)&&list.some(file=>object(file).path===skill.path)));
  if(!shared){await rm(skill.path);files.push(skill.path);}
 }
 await rm(path,{force:true});return {installed:false,files,instructions:[]};
}

export async function adapterInstalled(profile:AdapterProfile,options:Options={}):Promise<boolean>{
 if(profile.id==='deepseek-harness'||profile.id==='doubao-work')return (await import('./_shared/native-install.ts')).isNativeInstalled(profile,{home:options.home??homedir(),cwd:options.cwd??process.cwd(),dshHome:options.dshHome??(options.home?undefined:process.env.DSH_HOME)});
 const manifest=await json(manifestPath(profile,options.home??homedir()));
 return Object.keys(manifest).length>0&&manifest.installed!==false;
}
/** Project discovery needs installation metadata, not host process/version probes. */
export async function listInstalledAgents(options:Options={}):Promise<Array<AdapterProfile&{installed:true}>>{
 const installed=await Promise.all(profiles.map(profile=>adapterInstalled(profile,options)));
 return profiles.filter((_,index)=>installed[index]).map(profile=>({...profile,installed:true}));
}
export async function listAgents():Promise<Array<AdapterProfile&{route:string;detected:boolean;version:string|null;installed:boolean;support:string}>>{
 return Promise.all(profiles.map(async profile=>{
  let version:string|null=null;let detected=false;
  if(profile.id!=='doubao-work')try{const result=await run(profile.command,['--version'],{timeout:2500,maxBuffer:8192});detected=true;version=(result.stdout||result.stderr).trim().split('\n')[0]??null;}catch{/* Not installed or no version probe supported. */}
  if(!detected&&process.platform==='darwin'&&['workbuddy','doubao-work'].includes(profile.id)){
   const bundle=profile.id==='doubao-work'?'DoubaoWork':'WorkBuddy';
   try{const output=await run('plutil',['-extract','CFBundleShortVersionString','raw',`/Applications/${bundle}.app/Contents/Info.plist`]);version=output.stdout.trim();detected=!!version;}catch{/* Desktop absent. */}
  }
  const installed=await adapterInstalled(profile);
  const matched=version!==null&&profile.versions.some(candidate=>version!.split(/\s+/).includes(candidate)||version!.split(/\s+/).includes(`v${candidate}`));
  return {...profile,route:profile.kind,detected,version,installed,support:!detected?'not-detected':matched?'version-matched':'unverified'};
 }));
}
