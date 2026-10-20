import test from 'node:test';
import assert from 'node:assert/strict';
import {commercialAuthority,commercialTaskAllowed} from '../commercial-auth.js';
const env={COMMERCIAL_COMPANIES_JSON:'["ah-company"]',COMMERCIAL_GATE_URL:'https://gate.test/v1/org/workflow/ai',COMMERCIAL_APP_ORIGIN:'https://app.test'};
const request=new Request('https://ai.test',{headers:{'X-Company-Session':'ordinary-company-session'}}),claims={oid:'oid',tid:'tenant'};
const okay={orgId:'ah-company',subject:'oid',issuer:'tenant',permissions:['send_email']};
test('commercial AI requires current Gate company and immutable identity, not audience or email alone',async()=>{
 for(const override of [{orgId:'other-company'},{subject:'other-person'},{issuer:'other-tenant'},null]) {
  let sent;
  const result=await commercialAuthority(request,env,claims,{token:'id-token',fetchImpl:async(url,options)=>{sent=options;return override===null ? new Response(null,{status:403}):Response.json({...okay,...override});}});
  assert.equal(result.ok,false);assert.equal(sent.redirect,'manual');assert.equal(sent.headers.Authorization,'Bearer ordinary-company-session');
 }
 const yes=await commercialAuthority(request,env,claims,{token:'id-token',fetchImpl:async()=>Response.json(okay)});assert.equal(yes.ok,true);assert.equal(yes.commercial,true);
});
test('company AI fails closed without company session, allow-list or responsive authority',async()=>{
 const result=await commercialAuthority(new Request('https://ai.test'),env,claims);assert.equal(result.ok,false);
 const missing=await commercialAuthority(request,{},claims);assert.equal(missing.ok,false);
 const offline=await commercialAuthority(request,env,claims,{fetchImpl:async()=>{throw Error('offline');}});assert.equal(offline.ok,false);
});
test('commercial AI settings and key material require manage_settings independently of mail work',()=>{
 assert.equal(commercialTaskAllowed({commercial:true,permissions:['send_email']},'runPrompt'),true);
 for(const task of ['keyStatus','setProviderKey','getRelayKey','setRelayKey','setModelAllow','getModelAllow'])assert.equal(commercialTaskAllowed({commercial:true,permissions:['send_email']},task),false);
 assert.equal(commercialTaskAllowed({commercial:true,permissions:['manage_settings']},'keyStatus'),true);
});
