export function logName(time = Date.now(), index = 0) {
  const date = new Date(time);
  const day = [date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('');
  return `saman_frontend_${date.getFullYear()}.${day}.${index}.log`;
}
export function line(record: object, time = Date.now()) {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = pad(date.getMonth()+1)+pad(date.getDate())+'/'+pad(date.getHours())+pad(date.getMinutes())+pad(date.getSeconds())+'.'+String(date.getMilliseconds()).padStart(3,'0')+'000';
  return `[123:456:${stamp}:INFO:FRONTEND(0)] [neotix] [office-api-logger] [page_load_metrics][doubaowork-chat][traceId-test][AhaPageLoadMetricsObserverPtr: 0x1] "[webview][unknown][flow-web][logifier-report]: ${JSON.stringify({version:1,...record})}", source:  (0)\n`;
}
export function ack(sid: string, q: string, index: number) {
  return line({type:'log',message:`SSE_ACK: \nqueryList: ${JSON.stringify([{question_id:q,message_index:index}])} \nackClientMeta: ${JSON.stringify({conversation_id:sid})}`});
}
export function metadata(sid: string, root: string, a: string, time: number) {
  const extra = JSON.stringify({agent_task_param:JSON.stringify({workspace:root}), running_messages:JSON.stringify({[a]:{started_at_ms:time}})});
  return line({type:'log', message:'Cmd: ConversationUpdate',meta:{conversation_id:sid, conversation_info:JSON.stringify({conversation_id:sid,extra})}});
}
export function lifecycle(sid: string, q: string, a: string, end = false, overrides = {}, time = Date.now()) {
  const eventName = end ? 'on_message_session_end' : 'on_message_receiving_start';
  return line({type:'event',message:eventName,eventName,meta:{mode_type:'work_task',is_local_computer_on:1,conversation_id:sid,send_message_id:q,receive_message_id:a,
    ...(end ? {session_success:'1',receive_success:'1',cancel_source:''} : {}),...overrides}}, time);
}
