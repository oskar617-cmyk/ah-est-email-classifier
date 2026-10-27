// Candidate tests use the normal provider adapter but never approve a model.
// Only a current settings administrator may exercise this bounded test path.
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function requireProbeAdmin(env, auth) {
  if (!auth?.ok) fail('Sign in before testing a model.', 401);
  if (auth.commercial) {
    if (!auth.permissions?.includes('manage_settings')) fail('Model tests require Manage Settings.', 403);
  } else if (!String(env.KEY_ADMINS || '').split(',').map(x => x.trim().toLowerCase()).includes(auth.email?.toLowerCase())) {
    fail('Only an AI settings admin can test a candidate model.', 403);
  }
}
export function validateProbe(p) {
  if (!['textIn', 'imageIn'].includes(p?.capability)) fail('Unknown test capability.');
  if (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 120 || typeof p.provider !== 'string' || !p.provider.trim()) fail('Choose the exact provider and model to test.');
  if (p.messages || typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.length > 60000) fail('A bounded test prompt is required.');
  if (!p.schema || typeof p.schema !== 'object' || Array.isArray(p.schema) || JSON.stringify(p.schema).length > 30000) fail('A test output schema is required.');
  const images = p.images || [];
  if (!Array.isArray(images) || images.length > 1 || (p.capability === 'textIn' && images.length)) fail('This test accepts at most one picture.');
  for (const image of images) {
    if (!['image/png', 'image/jpeg'].includes(image?.mimeType) || typeof image.base64 !== 'string' || image.base64.length > 2000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) fail('The test picture is invalid or too large.');
  }
  // Image tests may make a second text-only call to analyse the OCR result.
  return { ...p, images };
}
