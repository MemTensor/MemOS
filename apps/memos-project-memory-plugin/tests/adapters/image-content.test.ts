import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripImages } from '../../src/adapters/_shared/image-content.ts';
const data = 'data:image/png;base64,SECRET_IMAGE_BYTES';
const tag = '<image name=[Image #1] path="/fixture.png">';
test('Codex labeled image keeps one original label, never payload or closing wrapper', () => {
 const input = {role:'user',content:[{type:'input_text',text:'inspect'}, {type:'input_text',text:tag},{type:'input_image',image_url:data},{type:'input_text',text:'</image>'}]};
 const output = stripImages(input);
 assert.deepEqual(output.content,[{type:'input_text',text:'inspect'},{type:'input_text',text:tag}]);
 assert.ok(JSON.stringify(input).includes('SECRET_IMAGE_BYTES'));assert.ok(!JSON.stringify(output).includes('SECRET_IMAGE_BYTES'));
 assert.deepEqual(stripImages(output),output);
});
test('local images share canonical labels by image position and anonymous images do not invent paths', () => {
 assert.deepEqual(stripImages([{type:'text',text:'inspect'},{type:'local_image',path:'/fixture.png'},{type:'local_image',path:'/second.png'}]),[
  {type:'text',text:'inspect'},{type:'text',text:tag},{type:'text',text:'<image name=[Image #2] path="/second.png">'}]);
 assert.deepEqual(stripImages({type:'input_image',image_url:data}),{type:'text',text:'[image]'});
});
test('MCP, Anthropic and tool JSON image payloads are removed at structured boundaries', () => {
 const input={raw:{content:[{type:'image',mimeType:'image/png',data:'SECRET_MCP'},{type:'image',source:{type:'base64',media_type:'image/png',data:'SECRET_ANTHROPIC'}}]},message:{role:'tool',content:JSON.stringify({content:[{type:'text',text:'ok'},{type:'image',data:'SECRET_TOOL',mimeType:'image/png'}]})},output:{image_url:data},generated:{type:'image_generation_call',id:'call',result:'SECRET_GENERATED'}};
 const out=stripImages(input);assert.ok(!JSON.stringify(out).includes('SECRET'));assert.match(JSON.stringify(out),/ok/);assert.equal(out.generated.id,'call');assert.equal(out.generated.type,'image_generation_call');
 assert.deepEqual(stripImages(out),out);
});
test('literal image examples, normal base64-like tool text and unmatched label text survive', () => {
 const prose='Example: data:image/png;base64,EXAMPLE and <image name=demo>';const literal='{"type":"image","data":"documented example"}';
 assert.deepEqual(stripImages({role:'user',content:literal}),{role:'user',content:literal});
 assert.deepEqual(stripImages({type:'text',text:prose}),{type:'text',text:prose});
 assert.deepEqual(stripImages({type:'text',text:'data:image/png;base64,example'}),{type:'text',text:'data:image/png;base64,example'});
 assert.equal(stripImages('ordinary-base64-looking-text'), 'ordinary-base64-looking-text');
 assert.deepEqual(stripImages([{type:'text',text:'</image>'}]),[{type:'text',text:'</image>'}]);
});
test('nested tool-result JSON inherits tool context without rewriting user or assistant JSON examples', () => {
 const image={type:'image',mimeType:'image/png',data:'SECRET_NESTED'};
 const encoded=JSON.stringify({content:[image]});
 const tool={role:'tool',content:[{type:'tool_result',content:encoded},{type:'text',text:JSON.stringify({content:[{type:'text',text:encoded}]})}]};
 const clean=stripImages(tool);
 assert.ok(!JSON.stringify(clean).includes('SECRET_NESTED'));
 assert.deepEqual(stripImages(clean),clean);
 for(const role of ['user','assistant']) {
   const example={role,content:[{type:'text',text:encoded}]};
   assert.deepEqual(stripImages(example),example);
 }
 assert.ok(!JSON.stringify(stripImages({type:'function_call_output',output:[{type:'text',text:encoded}]})).includes('SECRET_NESTED'));
});
