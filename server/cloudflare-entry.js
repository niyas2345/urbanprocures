import {handleNative} from './cloudflare-native.js';
import {serveStatic} from './static-routes.js';
const STATIC_ASSETS = {};

function secure(response,url){
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','strict-origin-when-cross-origin');
  headers.set('X-Frame-Options','SAMEORIGIN');
  headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(url.protocol==='https:')headers.set('Strict-Transport-Security','max-age=31536000');
  if(!headers.has('Content-Security-Policy'))headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);let response;
    try{
      if(url.pathname.startsWith('/api/native/'))response=await handleNative(request,env);
      else if(url.pathname.startsWith('/api/'))response=Response.json({ok:false,error:'Not found'},{status:404,headers:{'Cache-Control':'no-store'}});
      else response=await serveStatic(url.pathname,request,env,STATIC_ASSETS);
    }catch(error){console.error('Application request failure',error?.name||'Error');response=new Response('Request could not be completed. Please retry.',{status:500,headers:{'Cache-Control':'no-store'}})}
    return secure(response,url);
  }
};
