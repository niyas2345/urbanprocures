const fields=new URLSearchParams(location.hash.slice(1));
const rfq=fields.get('rfq')||new URLSearchParams(location.search).get('rfq');
const token=fields.get('token')||(rfq?sessionStorage.getItem('urban-owner:'+rfq):null);
if(rfq&&token)sessionStorage.setItem('urban-owner:'+rfq,token);
history.replaceState(null,'',location.pathname+(rfq?'?rfq='+encodeURIComponent(rfq):''));
const message=document.getElementById('ownerMessage'),content=document.getElementById('ownerContent');
const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value||'';return node};
async function api(path,body){
  const response=await fetch('/api/native/rfqs/'+encodeURIComponent(rfq)+path,{method:body?'POST':'GET',credentials:'omit',headers:{'X-Owner-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data;
}
async function load(){
  const {rfq:request}=await api('');content.replaceChildren();message.textContent=request.status==='awarded'?'Award confirmed. Contact details are available below.':'Review the quotations below. Vendor identities stay private until award.';
  document.getElementById('requestTitle').textContent=request.title;content.append(text('p',request.scope));
  for(const quote of request.quotations){
    const card=document.createElement('section');card.className='auth-card';card.append(text('h2',quote.vendor?.company_name||quote.vendor_label),text('p',new Intl.NumberFormat('en-AE',{style:'currency',currency:'AED'}).format(quote.amount_aed)),text('p',quote.notes));
    if(quote.vendor)card.append(text('p',[quote.vendor.contact_name,quote.vendor.contact_email,quote.vendor.phone].filter(Boolean).join(' · ')));
    if(request.status==='quoting'){
      const button=text('button','Confirm award');button.className='btn';button.type='button';
      button.onclick=async()=>{if(!confirm('Confirm this award? Contact details will be released to both parties.'))return;button.disabled=true;try{await api('/award',{quotation_id:quote.id});await load()}catch(error){message.textContent=error.message;button.disabled=false}};
      card.append(button);
    }
    content.append(card);
  }
  if(!request.quotations.length)content.append(text('p','No quotations have been submitted yet. Reopen your email link to check later.'));
  for(const document of request.documents||[]){const button=text('button','Open reviewed '+(document.kind==='quotation'?'quotation':'work pack'));button.className='btn';button.onclick=async()=>{button.disabled=true;try{const response=await fetch(document.url,{credentials:'omit',headers:{'X-Owner-Token':token}});if(!response.ok)throw Error('Document could not be opened. Please retry.');const url=URL.createObjectURL(await response.blob());const a=window.document.createElement('a');a.href=url;a.download='reviewed-work-pack.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(error){message.textContent=error.message}finally{button.disabled=false}};content.append(button)}
  const messages=await api('/clarifications');
  const thread=window.document.createElement('section');thread.className='auth-card';thread.append(text('h2','Clarifications'));
  for(const item of messages.clarifications)thread.append(text('p',item.sender+' · '+item.sanitized_message));
  if(request.status==='quoting'){const form=window.document.createElement('form');const label=text('label','Clarification (no names or contacts)');const input=window.document.createElement('textarea');input.required=true;input.maxLength=10000;label.append(input);const button=text('button','Send clarification');button.className='btn';form.append(label,button);form.onsubmit=async event=>{event.preventDefault();button.disabled=true;try{await api('/clarifications',{message:input.value});await load()}catch(error){message.textContent=error.message;button.disabled=false}};thread.append(form)}
  content.append(thread);
}
if(!rfq||!token)message.textContent='Open the access link sent to your email. Contact Urban Procures if the link has expired.';
else load().catch(error=>message.textContent=error.message);
