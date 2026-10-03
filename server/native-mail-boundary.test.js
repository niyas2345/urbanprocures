import test from 'node:test';
import assert from 'node:assert/strict';
import {ZohoEmailProvider,createOutreachProvider} from './ai/outreach-provider.js';
test('native mail never falls back to legacy database credentials',async()=>{
 const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected request')};
 try{const env={SUPABASE_URL:'https://legacy.invalid',SUPABASE_SECRET_KEY:'unused'};assert.equal(await new ZohoEmailProvider({env}).ready(),false);assert.equal(createOutreachProvider(env).getProvider('email'),undefined);assert.equal(calls,0)}finally{globalThis.fetch=saved}
});
test('preview mail denies nonallowlisted recipients before requesting a provider token',async()=>{
 const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Unexpected request')};
 try{const provider=new ZohoEmailProvider({env:{APP_ENV:'preview',PREVIEW_EMAIL_ALLOWLIST:'audit@example.test',ZOHO_CLIENT_ID:'fixture',ZOHO_CLIENT_SECRET:'fixture',ZOHO_REFRESH_TOKEN:'fixture',ZOHO_ACCOUNT_ID:'fixture'}});const result=await provider.sendEmail({to:'customer@example.test',subject:'Fixture',body:'Fixture'});assert.equal(result.success,false);assert.match(result.reason,/allowlisted/);assert.equal(calls,0)}finally{globalThis.fetch=saved}
});
