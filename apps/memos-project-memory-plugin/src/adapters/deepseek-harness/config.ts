import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

export interface DshConfig {path:string;block:string}
const start='# memos-project-memory:start';
const end='# memos-project-memory:end';
async function read(path:string):Promise<string>{
 try{return await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
}
function strip(text:string,previous?:DshConfig):string{
 if(previous&&text.includes(previous.block))return text.replace(previous.block,'');
 if(text.includes(start)||text.includes(end))throw new Error('MemOS DSH configuration was edited; preserve or remove its marked block before reinstalling.');
 return text;
}
/** Edit only our marked block; preserve Cordis tags, expressions and user comments. */
export async function installDshConfig(dshHome:string,wrapper:string,previous?:DshConfig):Promise<DshConfig>{
 const path=join(dshHome,'cordis.patch.yml');
 if(previous&&previous.path!==path)await removeDshConfig(previous);
 let text=strip(await read(path),previous?.path===path?previous:undefined);
 const meaningful=text.split(/\r?\n/).filter(line=>line.trim()&&!line.trimStart().startsWith('#'));
 if(meaningful.length===1&&/^\s*\[\s*\]\s*(?:#.*)?$/.test(meaningful[0]!)){
  text=text.replace(/^(\s*)\[\s*\](\s*(?:#.*)?)$/m,'$1$2');
 }else if(meaningful.length&&(!/^\s*-\s/.test(meaningful[0]!)||meaningful.some(line=>/^(?:---|\.\.\.)\s*$/.test(line)))){
  throw new Error('DSH cordis.patch.yml must be a block-style patch list (or an empty list).');
 }
 const block=`\n${start}\n- insert:\n    - id: memos-project-memory\n      name: ${JSON.stringify(wrapper)}\n${end}\n`;
 await mkdir(dirname(path),{recursive:true});await writeFile(path,text+block);
 return {path,block};
}
export async function removeDshConfig(config:DshConfig):Promise<void>{
 const text=await read(config.path);const remaining=strip(text,config);
 if(remaining!==text){
  const hasEntries=remaining.split(/\r?\n/).some(line=>line.trim()&&!line.trimStart().startsWith('#'));
  await writeFile(config.path,hasEntries?remaining:remaining+'\n[]\n');
 }
}
export async function hasDshConfig(config:DshConfig,dshHome:string):Promise<boolean>{
 return config.path===join(dshHome,'cordis.patch.yml')&&(await read(config.path)).includes(config.block);
}
