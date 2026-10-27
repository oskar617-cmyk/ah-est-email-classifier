import test from 'node:test';
import assert from 'node:assert/strict';
import { doProbeModel, doRunPrompt } from '../worker.js';
import { commercialTaskAllowed } from '../commercial-auth.js';
const admin = { ok: true, email: 'owner@example.test' };
const commercial = { ...admin, commercial: true, permissions: ['manage_settings'] };
const payload = { provider: 'groq', model: 'test-candidate', capability: 'textIn', prompt: 'Synthetic test', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } };
let writes, calls;
const env = { KEY_ADMINS: admin.email, KEYS: { get: async k => k === 'model-allow' ? JSON.stringify({ models: [{ provider: 'groq', id: 'existing' }] }) : JSON.stringify({ apiKey: 'synthetic' }), put: async () => { writes++; } } };
test('candidate test uses selected provider without approving or assigning it', async () => {
  writes = 0; calls = 0;
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { calls++; assert.equal(JSON.parse(init.body).model, payload.model); return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }); };
  try {
    const r = await doProbeModel(env, payload, admin);
    assert.equal(r.output.ok, true); assert.equal(r.model, payload.model); assert.equal(calls, 1); assert.equal(writes, 0);
    await assert.rejects(doRunPrompt(env, { ...payload, bypassApproval: true, probe: true }), /approved list/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = old; }
});
test('test admission requires valid ticket and current settings permission', async () => {
  await assert.rejects(doProbeModel(env, payload, { ok: false }), { status: 401 });
  await assert.rejects(doProbeModel(env, payload, { ok: true, email: 'user@example.test' }), { status: 403 });
  await assert.rejects(doProbeModel(env, payload, { ...commercial, permissions: ['send_email'] }), { status: 403 });
  assert.equal(commercialTaskAllowed(commercial, 'probeModel'), true);
  assert.equal(commercialTaskAllowed({ ...commercial, permissions: ['edit_budget'] }, 'probeModel'), false);
});
test('oversized, malformed and wrong-capability inputs never reach a provider', async () => {
  for (const change of [{ prompt: 'x'.repeat(60001) }, { schema: null }, { capability: 'audio' }, { model: '' }, { messages: [] }, { images: [{ base64: 'AAAA', mimeType: 'image/png' }] }, { capability: 'imageIn', images: [{ base64: 'bad!', mimeType: 'image/png' }] }]) {
    await assert.rejects(doProbeModel(env, { ...payload, ...change }, commercial), { status: 400 });
  }
});
test('empty and schema-invalid model replies cannot pass a picture test', async () => {
  const old = globalThis.fetch;
  try {
    for (const output of ['null', '{"wrong":true}']) {
      globalThis.fetch = async () => Response.json({ choices: [{ message: { content: output } }] });
      await assert.rejects(doProbeModel(env, { ...payload, capability: 'imageIn', images: [{ base64: 'AAAA', mimeType: 'image/png' }] }, commercial), { status: 422 });
    }
  } finally { globalThis.fetch = old; }
});
