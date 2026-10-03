const limits={bytes:10000000,entries:500,expanded:250000000};
export async function validateUpload(file){
  if(!(file instanceof File)||file.size<1||file.size>limits.bytes)throw Error('Choose a supported document under 10 MB');
  const name=file.name.split(/[\\/]/).pop();
  const ext=name.split('.').pop().toLowerCase();
  const bytes=new Uint8Array(await file.arrayBuffer()),ascii=new TextDecoder().decode(bytes.slice(0,32));
  let mime;
  if(ext==='pdf'&&ascii.startsWith('%PDF-'))mime='application/pdf';
  if(ext==='png'&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))mime='image/png';
  if(['jpg','jpeg'].includes(ext)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
  if(['txt','csv'].includes(ext)){
    try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!bytes.some(b=>b===0||(b<32&&![9,10,13].includes(b))))mime=ext==='csv'?'text/csv':'text/plain'}catch{}
  }
  if(['docx','xlsx','pptx','zip'].includes(ext)){
    const entries=zipEntries(bytes);
    const required={docx:'word/document.xml',xlsx:'xl/workbook.xml',pptx:'ppt/presentation.xml'};
    if(entries&&(!required[ext]||entries.includes(required[ext])))mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',zip:'application/zip'}[ext];
  }
  if(ext==='dwg'&&/^AC10\d{2}/.test(ascii))mime='application/acad';
  if(ext==='dxf'&&/^\s*0\s+SECTION\s/i.test(new TextDecoder().decode(bytes.slice(0,256))))mime='image/vnd.dxf';
  if(!mime)throw Error('File contents do not match a supported PDF, image, text, Office, ZIP or CAD document');
  return {bytes,mime,name:name.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,180)};
}
function zipEntries(bytes){
  if(bytes.length<22)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break}
  if(end<0||view.getUint16(end+4,true)||view.getUint16(end+6,true))return null;
  const count=view.getUint16(end+10,true);let offset=view.getUint32(end+16,true),expanded=0;
  if(!count||count>limits.entries||offset>=end)return null;
  const names=[];
  for(let i=0;i<count;i++){
    if(offset+46>end||view.getUint32(offset,true)!==0x02014b50)return null;
    const flags=view.getUint16(offset+8,true),size=view.getUint32(offset+24,true),packed=view.getUint32(offset+20,true),len=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true);
    if(flags&1||offset+46+len+extra+comment>end)return null;
    const name=new TextDecoder().decode(bytes.slice(offset+46,offset+46+len));
    if(!name||name.includes('..')||name.startsWith('/')||name.includes('\\')||/\.(exe|dll|bat|cmd|com|scr|js|vbs|ps1|html|htm|vba)$/i.test(name)||/vbaProject|macros/i.test(name))return null;
    expanded+=size;if(expanded>limits.expanded||(size>0&&(packed===0||size/packed>200)))return null;
    names.push(name);offset+=46+len+extra+comment;
  }
  return names;
}

export function validStorageKey(key){return typeof key==='string'&&/^(private|sanitized)\/[a-z_]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\.txt)?$/.test(key)}
