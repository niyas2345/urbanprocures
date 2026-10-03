window.navigateTo=name=>{
  const [page,hash]=String(name||'index').replace(/\.html(?=#|$)/i,'').split('#');
  location.assign(window.urbanRoute(page==='home'?'index':page)+(hash?'#'+hash:''));
};
window.goBack=()=>history.length>1?history.back():location.assign('/');
const sticky=document.getElementById('sticky');if(sticky)window.addEventListener('scroll',()=>sticky.style.display=scrollY>400?'flex':'none');
document.querySelectorAll('#cookie button').forEach(button=>button.addEventListener('click',()=>document.getElementById('cookie').hidden=true));
const grid=document.getElementById('vendorGrid');
if(grid){
  let vendors=[];
  const paint=()=>{
    const search=(document.getElementById('searchVendor')?.value||'').trim().toLowerCase(),category=(document.getElementById('filterCategory')?.value||'').trim().toLowerCase();
    grid.replaceChildren();
    for(const vendor of vendors.filter(v=>(!search||v.company_name.toLowerCase().includes(search))&&(!category||v.categories.some(c=>c.toLowerCase()===category)))){
      const card=document.createElement('div');card.className='panel vendor-card';
      const heading=document.createElement('div');heading.style.cssText='display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem';
      const avatar=document.createElement('div');avatar.style.cssText='width:3rem;height:3rem;border-radius:10px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:800';avatar.textContent=vendor.company_name.split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase();
      const label=document.createElement('div'),title=document.createElement('strong');title.style.fontSize='.95rem';title.textContent=vendor.company_name;
      const location=document.createElement('p');location.className='muted';location.style.fontSize='.78rem';location.textContent=vendor.emirate||'UAE';label.append(title,location);heading.append(avatar,label);
      const categories=document.createElement('div');categories.style.cssText='display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.75rem';
      for(const name of vendor.categories){const chip=document.createElement('span');chip.className='chip';chip.textContent=name;categories.append(chip)}
      const footer=document.createElement('div');footer.style.cssText='display:flex;justify-content:space-between;align-items:center';const badge=document.createElement('span');badge.className='badge verified';badge.textContent='Verified';const join=document.createElement('button');join.className='tiny';join.type='button';join.textContent='Join as vendor';join.onclick=()=>window.navigateTo('signup');footer.append(badge,join);card.append(heading,categories,footer);grid.append(card);
    }
    if(!grid.children.length){const empty=document.createElement('p');empty.className='empty-note';empty.textContent=vendors.length?'No verified vendors match that filter.':'No verified vendors yet. Register as a vendor and our team will review your licence.';grid.append(empty)}
  };
  fetch('/api/native/public/vendors').then(async response=>{if(!response.ok)throw Error('Vendor directory is unavailable. Please retry.');vendors=(await response.json()).vendors;paint()}).catch(error=>{grid.textContent=error.message;const retry=document.createElement('button');retry.className='tiny';retry.textContent='Retry';retry.onclick=()=>location.reload();grid.append(retry)});
  for(const id of ['searchVendor','filterCategory','filterStatus'])document.getElementById(id)?.addEventListener(id==='searchVendor'?'input':'change',paint);
}
// The legacy client landing form leads into the canonical native registration.
document.getElementById('clientForm')?.addEventListener('submit',event=>{event.preventDefault();location.assign('/signup#client')});
