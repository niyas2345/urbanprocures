import {scryptAsync} from '@noble/hashes/scrypt.js';
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
export function equalHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
let queue=Promise.resolve(),pending=0;
export async function passwordHash(password, salt) {
  if(pending>=16){const error=new Error('Authentication is busy');error.name='PasswordCapacityError';throw error;}
  pending++;
  const operation=queue.then(async()=>{
    const bits=await scryptAsync(encoder.encode(password),encoder.encode(`urban-procures-v2:${salt}`),{N:32768,r:8,p:3,dkLen:32,maxmem:64*1024*1024});
    return `scrypt$32768$8$3$${hex(bits)}`;
  });
  queue=operation.then(()=>{},()=>{});
  try{return await operation;}finally{pending--;}
}
export async function verifyPassword(password, salt, stored) {
  if (/^[a-f0-9]{64}$/.test(stored || '')) {
    const legacy = hex(await crypto.subtle.digest('SHA-256', encoder.encode(`urban-procures-native-v1:${salt}:${password}`)));
    return {valid: equalHash(legacy, stored), upgrade: true};
  }
  if (!/^scrypt\$32768\$8\$3\$[a-f0-9]{64}$/.test(stored || '')) return {valid: false, upgrade: false};
  return {valid: equalHash(await passwordHash(password, salt), stored), upgrade: false};
}
