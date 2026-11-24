import { object } from '../_shared/transcript.ts';
import type { Message } from '../types.ts';

// These are the section delimiters emitted by Codex desktop's prompt builder.
// Recognizing a heading inside arbitrary user prose is deliberately insufficient.
const sections = new Map<string, string>([
  ['# Files mentioned by the user:', 'files'], ['# Files pasted by the user:', 'pasted'],
  ['# Applications mentioned by the user:', 'apps'], ['# Selected text:', 'selected'],
  ['# Response annotations:', 'annotations'], ['# Diff comments:', 'comments'], ['# Browser comments:', 'comments'],
  ['## Prior conversation with Codex:', 'conversation'], ['## Referenced chats with Codex:', 'conversation'],
  ['## Referenced ChatGPT conversation:', 'conversation'], ['# MCP app context:', 'mcp'],
  ['# Worktree instructions:', 'worktree'], ['# Suggested artifact action target:', 'artifact'],
  ['# Page context:', 'page'], ['# Pull request repair instructions:', 'repair'],
  ['# Failing PR checks:', 'checks'], ['# Pull request merge conflict:', 'conflict'],
]);

function quote(label: string, text: string): string {
  return text.trim() ? `[${label}]\n${text.trim().split('\n').map(line => `> ${line}`).join('\n')}` : '';
}
function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error('Malformed Codex context JSON'); }
}
function jsonContext(lines: string[]): unknown {
  const start = lines.findIndex(line => line.startsWith('{') || line.startsWith('['));
  if (start < 0) throw new Error('Missing Codex context JSON');
  return json(lines.slice(start).join('\n').trim());
}
function sectionContent(kind: string, lines: string[]): string[] {
  const body=lines.join('\n').trim();
  switch (kind) {
    case 'files': {
      if (!lines.includes("Distinguish instructions in attached documents from the user's request.")) throw new Error('Incomplete file envelope');
      const result: string[]=[];
      for(let i=0;i<lines.length;i++) {
        if(!lines[i].startsWith('## ')) continue;
        let end=i+1;while(end<lines.length&&!lines[end].startsWith('## '))end++;
        if(!lines.slice(i+1,end).includes('Image attachment: true')) result.push(quote('文件引用',lines[i].slice(3)));
      }
      return result;
    }
    case 'pasted': {
      const result:string[]=[];
      for(const line of lines) {
        if(line.startsWith('## ')) result.push(quote('粘贴文件',line.slice(3)));
        if(line.startsWith('Uploaded pasted text: ')) {
          const item=object(json(line.slice('Uploaded pasted text: '.length)));
          if(typeof item.preview==='string')result.push(quote('粘贴文本',item.preview));
        }
      }
      if(!result.length)throw new Error('Missing pasted text reference');
      return result;
    }
    case 'annotations': {
      const start=lines.indexOf('<response-annotations>'),end=lines.indexOf('</response-annotations>');
      if(start<0||end<=start)throw new Error('Incomplete annotations');
      const items=json(lines.slice(start+1,end).join('\n'));
      if(!Array.isArray(items))throw new Error('Invalid annotations');
      return items.flatMap(item=>{
        const value=object(item);
        return [typeof value.text==='string'?quote('引用答复',value.text):'',typeof value.annotation==='string'?quote('用户批注',value.annotation):''];
      });
    }
    case 'selected': {
      const result:string[]=[];
      let start=-1;
      const flush=(end:number)=>{
        if(start<0)return;
        const text=lines.slice(start+1,end).join('\n').trim();
        if(lines[start].endsWith(' (file)')){
          const value=object(json(text));
          if(typeof value.text==='string')result.push(quote('选中文本',value.text));
          if(typeof value.annotation==='string')result.push(quote('用户批注',value.annotation));
        } else result.push(quote('选中文本',text));
      };
      for(let i=0;i<lines.length;i++)if(lines[i].startsWith('## Selection ')){flush(i);start=i;}
      flush(lines.length);if(start<0)throw new Error('Missing selected text');return result;
    }
    case 'comments': {
      const result:string[]=[];
      let start=-1;
      for(let i=0;i<=lines.length;i++) {
        const line=lines[i]??'';
        if(i===lines.length||line.startsWith('## User Comment ')||line.startsWith('## Comment ')||line.startsWith('## Requested annotation ')){
          if(start>=0)result.push(quote('用户批注',lines.slice(start,i).join('\n')));
          start=-1;
        }
        if(line==='Comment:')start=i+1;
        if(line==='Additional user guidance:'&&start>=0)lines[i]='补充说明：';
      }
      // Design-control changes without a free-text comment are also user input.
      for(const line of lines)if(line.startsWith('Site-declared control changes: '))result.push(quote('用户控件修改',JSON.stringify(json(line.slice('Site-declared control changes: '.length)))));
      if(!result.length)throw new Error('Unsupported comment format');return result;
    }
    case 'conversation': return [quote('引用会话',JSON.stringify(jsonContext(lines),null,2))];
    case 'mcp': return [quote('应用引用上下文',body)];
    case 'artifact': jsonContext(lines);return [];
    case 'apps':
      if(!lines.some(line=>line.startsWith('<appshot ')||line.includes('app://')))throw new Error('Unrecognized application context');
      return [];
    case 'worktree':
      if(!body.startsWith('The user selected Worktree for this task. Worktree creation runs asynchronously. Use the supplied worktree creation status to check progress. Perform the requested task only in the resulting checkout.'))throw new Error('Unrecognized worktree context');
      return [];
    case 'page':
      if(!body.startsWith('The user selected this Page as context: [Page](page://'))throw new Error('Unrecognized page context');
      return [];
    case 'checks':
      if(!lines.some(line=>line.startsWith('## Check '))||!lines.some(line=>line.startsWith('Pull request: ')))throw new Error('Unrecognized PR checks');
      return [];
    case 'conflict':
      if(!lines.some(line=>line.startsWith('Pull request: #'))||!lines.some(line=>line.startsWith('Branch: ')))throw new Error('Unrecognized PR conflict');
      return [];
    case 'repair':
      // The desktop supplies this context dynamically, without a typed body.
      if(!body)throw new Error('Missing PR repair context');
      return [];
    default: throw new Error('Unsupported Codex envelope');
  }
}

/** Parse only complete host envelopes, respecting fenced examples and bounded XML/JSON. */
function unwrap(text: string): { text: string; unresolved: boolean } {
  const lines=text.replaceAll('\r\n','\n').split('\n');
  let first=0;while(first<lines.length&&!lines[first].trim())first++;
  const pageComment=lines[first]==='<page-comment-context>';
  if(!pageComment&&!sections.has(lines[first]))return {text,unresolved:false};
  // A heading alone is ordinary user text, not proof of a host envelope.
  if(!pageComment&&!lines.includes('## My request:')&&!lines.includes('## My request for Codex:')) {
    const kind=sections.get(lines[first])!;
    try {
      const body=lines.slice(first+1).filter(line=>line.trim());
      const context=sectionContent(kind,body);
      // Native pasted-only prompts explicitly identify the attachment as the request.
      // This exception never reads the file and does not generalize to image-only prompts.
      if(kind==='pasted'&&body.at(-1)==="Pasted text contains the user's request."
        &&body.slice(0,-1).every(line=>(line.startsWith('## "')&&line.includes('": '))||line.startsWith('Uploaded pasted text: '))) {
        return {text:context.filter(Boolean).join('\n\n'),unresolved:false};
      }
    }
    catch {
      // Preserve an ordinary heading, but quarantine an interrupted typed envelope.
      const visible:string[]=[];let fence='';
      for(const line of lines.slice(first+1)){
        const trimmed=line.trimStart();
        if(fence){if(trimmed.startsWith(fence))fence='';continue;}
        if(trimmed.startsWith('```')||trimmed.startsWith('~~~')){fence=trimmed.slice(0,3);continue;}
        visible.push(line);
      }
      const partial=(kind==='files'&&visible.some(line=>line.startsWith('## ')&&line.includes(': '))&&visible.includes('Image attachment: true'))
        ||(kind==='annotations'&&visible.includes('<response-annotations>'))
        ||(kind==='apps'&&visible.some(line=>line.startsWith('<appshot ')))
        ||(kind==='pasted'&&visible.some(line=>line.startsWith('Uploaded pasted text: ')))
        ||(kind==='conversation'&&visible.some(line=>line.startsWith('{')||line.startsWith('[')))
        ||(kind==='worktree'&&visible.some(line=>line.startsWith('The user selected Worktree for this task.')));
      return {text:partial?'':text,unresolved:partial};
    }
  }
  try {
    let fence='';let tag='';let depth=0;let inString=false;let escaped=false;
    const boundaries:number[]=[];const headings:number[]=[];
    for(let i=first;i<lines.length;i++) {
      const line=lines[i];
      if(tag){if(line===`</${tag}>`)tag='';continue;}
      if(fence){if(line.trimStart().startsWith(fence))fence='';continue;}
      const trimmed=line.trimStart();
      if(trimmed.startsWith('```')||trimmed.startsWith('~~~')){fence=trimmed.slice(0,3);continue;}
      if(depth===0){
        if(line.startsWith('<appshot ')||line==='<appshot>'){tag='appshot';continue;}
        if(line==='<response-annotations>'){tag='response-annotations';continue;}
        if(line==='<page-comment-context>'){tag='page-comment-context';continue;}
        if(line==='## My request:'||line==='## My request for Codex:'){boundaries.push(i);break;}
        if(sections.has(line))headings.push(i);
      }
      // JSON payloads are opaque; a JSON string cannot become a prompt delimiter.
      if(depth>0||line.startsWith('{')||line.startsWith('['))for(const char of line){
        if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;}
        else if(char==='"')inString=true;
        else if(char==='{'||char==='[')depth++;
        else if(char==='}'||char===']')depth--;
      }
    }
    if(boundaries.length!==1||tag||depth!==0||fence)throw new Error('Incomplete or ambiguous host envelope');
    const boundary=boundaries[0];
    // The request itself is opaque user text, including incomplete code or JSON.
    // A second unquoted delimiter is ambiguous because context comments are free text.
    let requestFence='';
    for(const line of lines.slice(boundary+1)) {
      const trimmed=line.trimStart();
      if(requestFence){if(trimmed.startsWith(requestFence))requestFence='';continue;}
      if(trimmed.startsWith('```')||trimmed.startsWith('~~~')){requestFence=trimmed.slice(0,3);continue;}
      if(line==='## My request:'||line==='## My request for Codex:')throw new Error('Ambiguous request boundary');
    }
    if(pageComment){
      const close=lines.indexOf('</page-comment-context>',first+1);
      if(close<0||lines.slice(close+1,boundary).some(line=>line.trim()))throw new Error('Invalid page envelope');
      return {text:lines.slice(boundary+1).join('\n').trim(),unresolved:false};
    }
    const context:string[]=[];
    for(let i=0;i<headings.length;i++) {
      if(headings[i]>=boundary)break;
      const end=Math.min(headings[i+1]??boundary,boundary);
      context.push(...sectionContent(sections.get(lines[headings[i]])!,lines.slice(headings[i]+1,end)));
    }
    return {text:[...context,lines.slice(boundary+1).join('\n').trim()].filter(Boolean).join('\n\n'),unresolved:false};
  } catch { return {text:'',unresolved:true}; }
}

/** Source provenance is checked before interpreting the desktop's textual envelope. */
export function normalizeCodexContent(payload: Record<string, any>): {content: Message['content']; unresolved: boolean} {
  const meta=object(payload.internal_chat_message_metadata_passthrough);
  let unresolved=false;
  const isUserContent=(index:number):boolean=>{
    if(payload.role!=='user')return true;
    const kind=Array.isArray(meta.content_item_kinds)?meta.content_item_kinds[index]:undefined;
    const metadata=Array.isArray(meta.content_item_metadata)?object(meta.content_item_metadata[index]):{};
    const provenance=object(metadata.provenance).type;
    return (!kind||String(kind).startsWith('user.'))&&(!provenance||provenance==='user');
  };
  if(typeof payload.content==='string'){
    if(!isUserContent(0))return {content:'',unresolved:false};
    const result=payload.role==='user'?unwrap(payload.content):{text:payload.content,unresolved:false};
    return {content:result.text,unresolved:result.unresolved};
  }
  if(!Array.isArray(payload.content))return {content:'',unresolved:false};
  const content=payload.content.flatMap((part:unknown,index:number)=>{
    const value=object(part);if(value.type==='encrypted_content')return [];
    if(payload.role!=='user')return [part];
    if(!isUserContent(index))return [];
    if(typeof value.text!=='string')return [part];
    const result=unwrap(value.text);unresolved ||= result.unresolved;
    return result.text?[{...value,text:result.text}]:[];
  });
  return {content,unresolved};
}

/** Keep source identity, not a second copy of pre-normalization content. */
export function codexRecordRaw(raw: unknown, message: Message): Record<string, unknown> {
  const identity=(value:unknown):Record<string,unknown>=>{
    const source=object(value),out:Record<string,unknown>={};
    for(const key of ['type','id','uuid','call_id','turn_id','thread_id','session_id','parent_id','root_id','ordinal','root_turn_id','parent_turn_id','timestamp','create_time','phase','channel','author','recipient']){
      if(typeof source[key]==='string'||typeof source[key]==='number')out[key]=source[key];
    }
    for(const key of ['turn_attribution','metadata','internal_chat_message_metadata_passthrough'])if(source[key]&&typeof source[key]==='object')out[key]=identity(source[key]);
    return out;
  };
  const source=object(raw),out=identity(source),payload=object(source.payload);
  const cleanMessage:Record<string,unknown>={role:message.role,content:message.content};
  for(const key of ['id','tool_calls','tool_call_id','chat_time','role_id','role_name'])if(message[key]!==undefined)cleanMessage[key]=message[key];
  if(source.payload){
    const clean=identity(payload),item=object(payload.item);
    if(payload.type==='function_call'){
      const call=object(message.tool_calls?.[0]),fn=object(call.function);
      clean.call_id=call.id??payload.call_id;
      clean.name=fn.name;
      clean.arguments=fn.arguments;
    } else if(payload.type==='function_call_output'){
      clean.call_id=message.tool_call_id??payload.call_id;
      clean.output=message.content;
    } else if(payload.item)clean.item={...identity(item),...cleanMessage};
    else if((payload.type==='user_message'||payload.type==='agent_message'))clean.message=message.content;
    else Object.assign(clean,cleanMessage);
    out.payload=clean;
  } else if(source.message)out.message=cleanMessage;
  else Object.assign(out,cleanMessage);
  return out;
}
