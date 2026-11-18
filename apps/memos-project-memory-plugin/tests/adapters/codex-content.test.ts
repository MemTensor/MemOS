import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexContent, codexRecordRaw } from '../../src/adapters/codex-cli/content-normalizer.ts';
const normalize = (content: string) => normalizeCodexContent({ role: 'user', content });
const files = "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n";
test('unwrap verified file envelope without relying on metadata', () => {
 assert.deepEqual(normalize(files + '## My request:\n请优化页面'), {content:'请优化页面',unresolved:false});
 assert.deepEqual(normalize(files + '## My request for Codex:\n请优化页面'), {content:'请优化页面',unresolved:false});
});
test('keep ordinary prose, quoted headings and fenced examples verbatim', () => {
 for(const text of ['为什么还有 # Files mentioned by the user: 模板', '## My request:\n只是标题', '```md\n'+files+'## My request:\n示例\n```', '> # Files mentioned by the user:\n> ## My request:\n说明']) assert.deepEqual(normalize(text),{content:text,unresolved:false});
});
test('structural provenance wins over apparently user supplied text', () => {
 const result=normalizeCodexContent({role:'user',content:[{type:'input_text',text:'host'},{type:'input_text',text:'real'},{type:'encrypted_content',data:'opaque'},{type:'input_image',image_url:'image'}],internal_chat_message_metadata_passthrough:{content_item_kinds:['developer.text','user.text'],content_item_metadata:[{provenance:{type:'developer'}},{provenance:{type:'user'}}]}});
 assert.deepEqual(result,{content:[{type:'input_text',text:'real'},{type:'input_image',image_url:'image'}],unresolved:false});
});
test('retain selected user text and annotations, not template instructions', () => {
 const content='# Selected text:\n## Selection 1 (file)\n'+JSON.stringify({path:'/tmp/a.ts',text:'const x = 1',annotation:'改名'})+'\n\n## My request:\n照此修改';
 const result=normalize(content); assert.equal(result.unresolved,false); assert.match(String(result.content),/const x = 1/);assert.match(String(result.content),/改名/);assert.match(String(result.content),/照此修改/);assert.doesNotMatch(String(result.content),/# Selected text:/);
 const annotations='# Response annotations:\nHost instructions\n<response-annotations>\n'+JSON.stringify([{text:'旧答复',annotation:'请展开'}])+'\n</response-annotations>\n\n## My request:\n继续';
 assert.match(String(normalize(annotations).content),/请展开/);assert.doesNotMatch(String(normalize(annotations).content),/Host instructions/);
});
test('preserve comments but drop browser and PR automation instructions', () => {
 const text='# Browser comments:\n## User Comment 1\nBrowser\nPage URL: https://example.com\nTarget: button\nComment:\n把按钮变小\nAdditional user guidance:\n保持配色\n\n# Pull request repair instructions:\nRun generated repair instructions\n\n## My request:\n修复';
 const result=normalize(text);assert.equal(result.unresolved,false);assert.match(String(result.content),/把按钮变小/);assert.match(String(result.content),/保持配色/);assert.doesNotMatch(String(result.content),/Run generated|Page URL|# Browser/);
});
test('preserve pasted previews and conversation references as context', () => {
 const text='# Files pasted by the user:\n## "notes": /tmp/notes\nUploaded pasted text: '+JSON.stringify({pointer:'sediment://1',fileName:'notes',preview:'实现缓存'})+'\nPasted text contains the user\'s request.\n\n## Prior conversation with Codex:\n'+JSON.stringify({messages:[{role:'user',content:'保留兼容性'}]})+'\n\n## My request:\n执行';
 const result=normalize(text); assert.equal(result.unresolved,false); assert.match(String(result.content),/实现缓存/); assert.match(String(result.content),/保留兼容性/); assert.doesNotMatch(String(result.content),/Pasted text contains/);
});
test('ignore request-looking lines inside bounded appshots, JSON and code fences', () => {
 const app='# Applications mentioned by the user:\nExample\n<appshot app="Example">\n## My request:\nAX\n</appshot>\n\n## My request:\n真正请求';
 assert.deepEqual(normalize(app),{content:'真正请求',unresolved:false});
 const selected='# Selected text:\n## Selection 1\n```md\n## My request:\nexample\n```\n\n## My request:\n实际请求';
 assert.equal(normalize(selected).unresolved,false);assert.match(String(normalize(selected).content),/实际请求/);
});
test('quarantine malformed and ambiguous known envelopes', () => {
 for(const text of [files, '# Response annotations:\n<response-annotations>\n{bad}\n</response-annotations>\n## My request:\nhello',files+'## My request:\none\n## My request:\ntwo']) assert.deepEqual(normalize(text),{content:'',unresolved:true});
});
test('page context and worktree envelope are not user requests', () => {
 const text='# Worktree instructions:\nThe user selected Worktree for this task. Worktree creation runs asynchronously. Use the supplied worktree creation status to check progress. Perform the requested task only in the resulting checkout.\n\n# Page context:\nThe user selected this Page as context: [Page](page://id).\n\n## My request:\n编辑页面';
 assert.deepEqual(normalize(text),{content:'编辑页面',unresolved:false});
 assert.deepEqual(normalize('<page-comment-context>\nhost context\n</page-comment-context>\n## My request:\n更正标题'),{content:'更正标题',unresolved:false});
});
test('raw projection retains event identity without retaining original wrappers',()=>{
 const raw=codexRecordRaw({type:'event_msg',timestamp:'now',payload:{type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'u',content:'secret wrapper'}},other:'secret'}, {role:'user',content:'actual'});
 assert.equal(JSON.stringify(raw).includes('secret'),false);assert.match(JSON.stringify(raw),/UserMessage/);assert.match(JSON.stringify(raw),/actual/);
});
test('opaque user request can contain unfinished JSON and code',()=>{
 for(const request of ['[请补全这个数组','```ts\nconst x =','<appshot app="example">'])assert.deepEqual(normalize(files+'## My request:\n'+request),{content:request,unresolved:false});
});
test('raw projection preserves turn attribution and normalized tool semantics',()=>{
 const raw=codexRecordRaw({ordinal:4,type:'event_msg',payload:{type:'agent_message',message:'old',turn_attribution:{root_turn_id:'r',parent_turn_id:'p'},internal_chat_message_metadata_passthrough:{turn_id:'t',content_item_kinds:['host.text']}}},{role:'assistant',content:'clean'});
 assert.equal(raw.ordinal,4);const payload=raw.payload as any; assert.equal(payload.message,'clean');assert.deepEqual(payload.turn_attribution,{root_turn_id:'r',parent_turn_id:'p'});assert.deepEqual(payload.internal_chat_message_metadata_passthrough,{turn_id:'t'});
 const tool=codexRecordRaw({type:'response_item',payload:{type:'function_call',arguments:'old'}},{role:'assistant',content:'',tool_calls:[{id:'call',function:{name:'run',arguments:'clean'}}]});
 assert.deepEqual(tool.payload,{type:'function_call',call_id:'call',name:'run',arguments:'clean'});
});
test('ordinary headings lack host structure and remain user prose',()=>{
 for(const text of ['# Applications mentioned by the user:\nI am explaining this title.', '# Worktree instructions:\nPlease document the checkout process.', '# Page context:\nHere are my own notes.'])assert.deepEqual(normalize(text),{content:text,unresolved:false});
 assert.deepEqual(normalize('# Page context:\nUnexpected host shape\n## My request:\ncontinue'),{content:'',unresolved:true});
});
test('truncated host signatures are quarantined even without a request boundary',()=>{
 for(const text of ['# Files mentioned by the user:\n\n## broken.png: /tmp/broken.png\nImage attachment: true','# Response annotations:\n<response-annotations>\n[', '# Applications mentioned by the user:\n<appshot app="Browser">'])assert.deepEqual(normalize(text),{content:'',unresolved:true});
});
test('single string content honors explicit content provenance',()=>{
 for(const metadata of [{content_item_kinds:['developer.text']},{content_item_metadata:[{provenance:{type:'developer'}}]}])assert.deepEqual(normalizeCodexContent({role:'user',content:'generated instructions',internal_chat_message_metadata_passthrough:metadata}),{content:'',unresolved:false});
});
test('canonical quoted context is idempotent',()=>{
 for(const input of [files+'## My request:\n真实请求','# Selected text:\n## Selection 1\nhello\n## My request:\n编辑','# Response annotations:\n<response-annotations>\n[{"text":"hello","annotation":"改一下"}]\n</response-annotations>\n## My request:\n实施']){
  const result=normalize(input);assert.equal(result.unresolved,false);assert.deepEqual(normalize(result.content as string),result);
 }
});
test('pasted-only request preserves references and preview without a request delimiter',()=>{
 const text='# Files pasted by the user:\n## "notes.txt": /tmp/notes.txt\nUploaded pasted text: '+JSON.stringify({pointer:'sediment://p',fileName:'notes.txt',preview:'修复缓存逻辑'})+"\nPasted text contains the user's request.";
 const result=normalize(text);assert.equal(result.unresolved,false);assert.match(String(result.content),/修复缓存逻辑/);assert.match(String(result.content),/\/tmp\/notes.txt/);assert.doesNotMatch(String(result.content),/Pasted text contains/);assert.deepEqual(normalize(result.content as string),result);
 assert.deepEqual(normalize(text+'\nunknown generated trailer'),{content:'',unresolved:true});
});
