import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
test('the Worker uses unmodified pinned Core provider adapters',()=>{
 const root=new URL('../vendor/vaenyx/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',root)));assert.equal(manifest.version,'1.4.0');
 for(const [name,hash]of Object.entries(manifest.files))assert.equal(createHash('sha256').update(fs.readFileSync(new URL(name,root))).digest('hex'),hash,name);
});