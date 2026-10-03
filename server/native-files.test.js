import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUpload,validStorageKey} from './native-files.js';
test('native uploads reject executable, spoofed, oversized and mismatched image files',async()=>{
  for(const file of [new File(['<html>unsafe</html>'],'renamed.pdf',{type:'application/pdf'}),new File(['executable'],'invoice.exe',{type:'application/pdf'}),new File(['%PDF-1.7'],'renamed.png',{type:'image/png'}),new File([new Uint8Array(10000001)],'big.pdf',{type:'application/pdf'})])await assert.rejects(validateUpload(file));
  assert.equal((await validateUpload(new File(['%PDF-1.7\n%%EOF'],'report.pdf',{type:'application/octet-stream'}))).mime,'application/pdf');
  assert.equal((await validateUpload(new File(['description,quantity\nMembrane,20'],'boq.csv',{type:'application/octet-stream'}))).mime,'text/csv');
  assert.equal(validStorageKey('private/rfq/request-1/document-1'),true);
  for(const key of ['../secrets','private/rfq/../document','https://example.test/file','private/rfq/id/file\n'])assert.equal(validStorageKey(key),false);
});
