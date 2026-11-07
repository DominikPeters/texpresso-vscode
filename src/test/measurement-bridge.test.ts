import { test } from 'node:test';
import * as assert from 'node:assert/strict';
const {normalize,JsonNumberBridge} = require('../../scripts/profiling/json-number-bridge.cjs');

test('measurement JSON bridge repairs only leading-dot numbers, preserving ordinary JSON and quoted text', () => {
  const input='{"bounds":[-.99,.25,0.125,-24.5,1.2e-7],"uri":"a,.9\\\"x-.7"}';
  const output=normalize(input);
  assert.deepEqual(JSON.parse(output),{bounds:[-.99,.25,.125,-24.5,1.2e-7],uri:'a,.9"x-.7'});
  assert.equal(normalize(output),output);
});

test('measurement JSON bridge preserves exact binary payloads across fragmented frame boundaries', async () => {
  const payload=Buffer.from([0,10,255,13,10,34,46,57]);
  const wire=Buffer.concat([Buffer.from('["preview-image",{"byteLength":8,"annotations":{"x":-.9}}]\n'),payload,Buffer.from('["done"]\n')]);
  for(const size of [1,2,7,wire.length]) {
    const bridge=new JsonNumberBridge(),chunks:Buffer[]=[];
    bridge.on('data',(chunk:Buffer)=>chunks.push(chunk));
    const done=new Promise<void>((resolve,reject)=>{bridge.once('end',resolve);bridge.once('error',reject);});
    for(let i=0;i<wire.length;i+=size) { bridge.write(wire.subarray(i,i+size)); }
    bridge.end();await done;
    const output=Buffer.concat(chunks),newline=output.indexOf(10);
    assert.deepEqual(output.subarray(newline+1,newline+9),payload);
    assert.equal(output.subarray(newline+9).toString(),'["done"]\n');
    assert.equal(JSON.parse(output.subarray(0,newline).toString())[1].annotations.x,-.9);
  }
});
