export function normalizeNativeFixture(value){
 if(!value||typeof value!=='object')return value;
 const v=structuredClone(value);
 if(Array.isArray(v.candidates))for(const c of v.candidates)c.finishReason??='STOP';
 if(Array.isArray(v.choices))for(const c of v.choices)c.finish_reason??='stop';
 return v;
}
