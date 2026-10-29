import test from 'node:test';
import assert from 'node:assert/strict';
import {doFetchUrl} from '../worker.js';
const original = globalThis.fetch;
async function mocked(fn, run) { globalThis.fetch = fn; try { await run(); } finally { globalThis.fetch = original; } }
test('linked quote returns actual PDF bytes and forwards no credentials', async () => mocked(async (_url, opts) => {
  assert.equal(opts.redirect, 'manual'); assert.equal(opts.credentials,'omit');
  assert.equal(opts.headers.Authorization,undefined); assert.equal(opts.headers.Cookie,undefined);
  return new Response('%PDF-1.7 TEST',{headers:{'content-type':'application/pdf'}});
}, async () => { const r=await doFetchUrl({url:'https://example.com/quote.pdf',includeDocument:true});assert.equal(atob(r.base64),'%PDF-1.7 TEST'); }));
test('redirects to private network are refused before request', async () => {
 let calls=0; await mocked(async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://169.254.169.254/'}});},async()=>{
  await assert.rejects(doFetchUrl({url:'https://example.com/quote'}),/private network/); assert.equal(calls,1);
 });
});
test('redirect loops and oversized chunked content stop with clear errors', async()=>{
 await mocked(async()=>new Response(null,{status:302,headers:{location:'https://example.com/loop'}}),async()=>await assert.rejects(doFetchUrl({url:'https://example.com/quote'}),/too many redirects/));
 await mocked(async()=>new Response('x'.repeat(3*1024*1024+1),{headers:{'content-type':'text/html'}}),async()=>await assert.rejects(doFetchUrl({url:'https://example.com/quote',includeDocument:true}),/too big/));
});
test('download discovery cannot offer acceptance, payment or terms as the quote', async()=>mocked(async()=>new Response(`<title>TEST Quote</title><p>Total $123</p><a href="/quote/1/print?download=true">Download</a><a href="/quote/1/accept">Accept</a><a href="/terms.pdf">Terms</a>`,{headers:{'content-type':'text/html'}}),async()=>{
 const r=await doFetchUrl({url:'https://example.com/quote',includeDocument:true});assert.equal(r.downloads.length,1);assert.match(r.downloads[0].url,/print/);
}));
test('new document mode retains full content beyond legacy preview cap',async()=>mocked(async()=>new Response('x'.repeat(15000)+'Total $123',{headers:{'content-type':'text/plain'}}),async()=>{
 const r=await doFetchUrl({url:'https://example.com/quote',includeDocument:true});assert.ok(r.text.endsWith('Total $123'));assert.equal(r.truncated,false);
}));
