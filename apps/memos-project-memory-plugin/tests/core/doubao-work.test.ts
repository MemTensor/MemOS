import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import { createLocalServer } from '../../src/server/http.ts';
import { doubaoSessionsPath } from '../../src/adapters/doubao-work/capture.ts';
import { DoubaoHost } from '../../src/adapters/doubao-work/host.ts';
import { ack, metadata, lifecycle, logName, line } from '../helpers/doubao-log.ts';
import { PluginService } from '../../src/server/service.ts';

test('uninstalled Doubao helper cannot start a cloud search', async t => {
  const home = await mkdtemp(join(tmpdir(), 'memos-doubao-'));
  const service = new PluginService(join(home, 'memos'), { home, codexRoots: [] });
  t.after(async () => { service.close(); await rm(home, { recursive:true, force:true }); });
  service.cloud.call = () => { throw new Error('unexpected cloud request'); };
  assert.equal((await service.searchDoubao({nativeSessionId:'11',answerId:'22',query:'find'})).status, 'CONTEXT_MISSING');
});

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
const closeServer = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('explicit projects, concurrent sessions and late turns through local HTTP and Mock delivery', async t => {
  const home = await mkdtemp(join(tmpdir(), 'memos-doubao-flow-'));
  const dataDir = join(home, 'memos'), a = join(home, 'selected A'), b = join(home, 'selected B');
  const options = {home,codexRoots:[]};
  let service = new PluginService(dataDir,options);
  let resume!: () => void, arrived!: () => void;
  const delayed = new Promise<void>(done => { resume = done; });
  const received = new Promise<void>(done => { arrived = done; });
  const searches: {query:string; space_ids:string[]; conversation_id:string}[] = [];
  const uploads: {space_ids:string[]; messages:{role:string; content:string}[]}[] = [];
  const mock = createServer(async (req,res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    let data:unknown;
    switch(req.url) {
      case '/get/space': data = {space_id:input.space_id,space_name:input.space_id}; break;
      case '/list/domains': data = {domains:[{domain:'engineering'}]}; break;
      case '/get/memory': data = {topic_detail_list:[]}; break;
      case '/search/memory':
        searches.push(input);
        if (input.query === 'delayed') { arrived(); await delayed; }
        data = {topic_detail_list:[{topic_summary:input.space_ids.join(',')}]}; break;
      case '/add/message': uploads.push(input); data = {success:true,task_id:'task-' + uploads.length}; break;
      case '/get/status': data = {status:'completed',task_id:input.task_id}; break;
      default: res.writeHead(404); res.end(); return;
    }
    res.end(JSON.stringify({code:0,data}));
  });
  const mockUrl = await listen(mock);
  const local = createLocalServer(service), url = await listen(local);
  t.after(async () => {
    resume();
    if (local.listening) await closeServer(local);
    service.close(); await closeServer(mock);
    await rm(home,{recursive:true,force:true});
  });
  service.configure({baseUrl:mockUrl,authMode:'none'});
  const installed = await fetch(url + '/api/adapters/doubao-work/install', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(installed.status,200);
  const skill = await readFile((await installed.json()).files[0],'utf8');
  const command = /```sh\n([^\n]+)\n```/.exec(skill)![1]!.replace("'<question>'", '"$1"');
  for (const [root,spaceId] of [[a,'alpha'],[a,'alpha-copy'],[b,'beta']]) {
    await service.bindProject({agentType:'doubao-work',root,spaceId});
  }
  const directory = new DoubaoHost(home).directory;
  await mkdir(directory,{recursive:true});
  const time = Date.now(), log = join(directory,logName(time));
  const open = (sid:string,q:string,aid:string,root:string,at:number,index:number) =>
    ack(sid,q,index) + metadata(sid,root,aid,at) + lifecycle(sid,q,aid);
  await writeFile(log, open('100','201','301',a,time,1) + open('101','202','302',b,time,1)
    + open('102','203','303',a,time,1) + open('103','204','304',join(a,'unbound child'),time,1));
  const query = async (nativeSessionId:string,answerId:string,query:string) => {
    const response = await fetch(url + '/api/doubao/search',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({nativeSessionId,answerId,query})});
    assert.equal(response.status,200); return response.json();
  };
  const cli = promisify(execFile)('/bin/sh',['-c',command,'skill','A'], {cwd:'/',env:{...process.env,
    MEMOS_PM_URL:url,MEMOS_PM_DATA_DIR:dataDir,MCP_VM_CONVERSATION_ID:'100',DOUBAO_OFFICE_ANSWER_MESSAGE_ID:'301'}})
    .then(({stdout})=>JSON.parse(stdout));
  const hits = await Promise.all([cli,query('101','302','B'),query('102','303','also A')]);
  assert.deepEqual(hits.map(hit=>hit.status),['FOUND','FOUND','FOUND']);
  const byQuery = new Map(searches.map(hit=>[hit.query,hit]));
  assert.deepEqual(byQuery.get('A')!.space_ids,['alpha','alpha-copy']);
  assert.deepEqual(byQuery.get('B')!.space_ids,['beta']);
  assert.deepEqual(byQuery.get('also A')!.space_ids,['alpha','alpha-copy']);
  assert.notEqual(byQuery.get('also A')!.conversation_id,byQuery.get('A')!.conversation_id);
  assert.equal((await query('100','302','wrong session')).status,'CONTEXT_MISSING');
  assert.equal((await query('103','304','unbound')).status,'CONTEXT_MISSING');
  assert.equal(searches.length,3);

  // Titles may arrive after registration, and retained logs can replay older updates.
  const rename = (name: string, version: number) => line({ type: 'log', message: 'Cmd: ConversationUpdate',
    meta: { conversation_id: '100', conversation_info: JSON.stringify({ conversation_id: '100', name, version }) } });
  const title = () => service.store.row("SELECT title FROM sessions WHERE agentType='doubao-work' AND nativeSessionId='100'")?.title;
  assert.equal(title(), null);
  await appendFile(log, rename('新对话', 10) + rename('绑定space', 12) + rename('较旧名称', 11));
  await t.waitFor(async () => {
    await service.refreshSessionTitles();
    assert.equal(title(), '绑定space');
  });

  const oldResponse = query('100','301','delayed');
  await received;
  const next = Date.now();
  await appendFile(log,open('100','205','305',a,next,4));
  resume();
  assert.equal((await oldResponse).status,'CONTEXT_MISSING');
  assert.equal((await query('100','301','old command')).status,'CONTEXT_MISSING');
  assert.equal((await query('100','305','new command')).status,'FOUND');
  assert.equal(searches.length,5);

  const system = async (sid:string, requests:[number,string][], rows:object[]) => {
    const path = join(doubaoSessionsPath(home),sid,'agents','m_test','system');
    await mkdir(path,{recursive:true});
    await writeFile(join(path,'assignment.md'),'# Assignment\n- Role: main\n- Assigned by: user\n\n'+requests.map(
      ([at,prompt])=>'## ['+new Date(at).toISOString()+'] 需求\n'+prompt+'\n').join('\n'));
    const journal = join(path,'trajectory.jsonl');
    await writeFile(journal,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    return journal;
  };
  const assistant = (content:string) => ({role:'assistant',content});
  await system('100',[[time,'A first'],[next,'A second']],[
    {role:'assistant',tool_calls:[{id:'tool-a',type:'function',function:{name:'Bash',arguments:{command:'pwd'}}}]},
    {role:'tool',tool_call_id:'tool-a',content:'selected A'},assistant('A first done'),
    {role:'user',content:'A second'},assistant('A second done'),
  ]);
  const journal = await system('101',[[time,'B first']],[{role:'assistant',tool_calls:[
    {id:'tool-b',type:'function',function:{name:'Bash',arguments:{command:'pwd'}}}]}]);
  await appendFile(log,lifecycle('100','205','305',true)+lifecycle('100','201','301',true)+lifecycle('101','202','302',true));
  await t.waitFor(()=>assert.equal(service.store.batches().length,2));
  await appendFile(journal,[{role:'tool',tool_call_id:'tool-b',content:'selected B'},assistant('B done')].map(row=>JSON.stringify(row)).join('\n')+'\n');
  await t.waitFor(()=>assert.equal(service.store.batches().length,3));
  await service.sync();
  const deliveries = () => uploads.map(({space_ids,messages})=>[space_ids.join(','),messages.map(m=>m.content)]).sort();
  const first = ['A first','','selected A','A first done'], second = ['A second','A second done'];
  assert.deepEqual(deliveries(),[['alpha',first],['alpha',second],['alpha-copy',first],['alpha-copy',second],
    ['beta',['B first','','selected B','B done']]].sort());
  const old = service.store.row("SELECT t.nativeKey FROM sessions s JOIN turns t ON t.id=s.currentTurnId WHERE s.nativeSessionId='100'");
  assert.equal(old?.nativeKey,'205');
  // The service misses the end event while down. Startup replays it from the log.
  service.configure({paused:true});
  await closeServer(local);
  service.close();
  await system('102',[[time,'while paused']],[assistant('finished offline')]);
  await appendFile(log,lifecycle('100','201','301',true)+lifecycle('102','203','303',true));
  await appendFile(log,rename('离线时改名', 13));
  service = new PluginService(dataDir,options);
  await t.waitFor(async () => {
    await service.refreshSessionTitles();
    assert.equal(title(), '离线时改名');
  });
  await t.waitFor(()=>assert.equal(service.store.batches().length,4));
  await service.sync();
  assert.equal(uploads.length,5);
  service.configure({paused:false});
  await service.sync();
  assert.equal(service.store.batches().filter(batch=>batch.status==='manual').length,1);
  await appendFile(log,open('104','208','308',a,Date.now(),1));
  const queryAfterRestart = {nativeSessionId:'104',answerId:'308',query:'after restart'};
  assert.equal((await service.searchDoubao(queryAfterRestart)).status,'FOUND');
  await service.changeAdapter('doubao-work',true);
  assert.equal((await service.searchDoubao(queryAfterRestart)).status,'CONTEXT_MISSING');
  assert.equal(uploads.length,5);
});
