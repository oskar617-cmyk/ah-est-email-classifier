// Commercial tickets do not gain access to this company's AI keys by audience alone.
export async function commercialAuthority(request,env,claims,{token,fetchImpl=fetch}={}) {
 const session=request.headers.get('X-Company-Session');
 if(!session)return {ok:false,present:true,message:'Open this company workspace before using AI.'};
 let allowed;try{allowed=JSON.parse(env.COMMERCIAL_COMPANIES_JSON || '[]');}catch{return {ok:false,present:true,message:'Company AI configuration is invalid.'};}
 if(!Array.isArray(allowed) || !allowed.length || !env.COMMERCIAL_GATE_URL || !env.COMMERCIAL_APP_ORIGIN)return {ok:false,present:true,message:'Company AI authorization is not configured.'};
 try {
  const response=await fetchImpl(env.COMMERCIAL_GATE_URL,{method:'POST',headers:{Authorization:'Bearer '+session,'Content-Type':'application/json',Origin:env.COMMERCIAL_APP_ORIGIN},body:JSON.stringify({idToken:token}),redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!response.ok)return {ok:false,present:true,message:'Company AI permission is no longer active. Reopen the company workspace.'};
  const authorization=await response.json();
  if(!allowed.includes(authorization.orgId) || authorization.subject!==claims.oid || authorization.issuer!==claims.tid || !Array.isArray(authorization.permissions))return {ok:false,present:true,message:'This company does not use this AI service.'};
  return {ok:true,present:true,commercial:true,permissions:authorization.permissions};
 }catch{return {ok:false,present:true,message:'Company AI authorization is unavailable. Nothing was sent to the model.'};}
}
export function commercialTaskAllowed(auth,task) {
 if(!auth.commercial)return true;
 if(['probeModel','setProviderKey','keyStatus','setModelAllow','getModelAllow','getRelayKey','setRelayKey'].includes(task))return auth.permissions.includes('manage_settings');
 return auth.permissions.some(p=>['edit_budget','send_email'].includes(p));
}
