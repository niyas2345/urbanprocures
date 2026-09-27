const api=async(path,body)=>{const r=await fetch('/api/native/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error||'Request failed');return v};
const message=(id,text,ok=false)=>{const p=document.getElementById(id);if(p){p.hidden=false;p.textContent=text;p.className='form-msg '+(ok?'ok':'error')}};
const val=(form,name)=>form.elements[name]?.value?.trim()||'';
const route=role=>location.assign(role==='admin'?'/admin/dashboard':`/${role}/dashboard`);
const login=async(form,msgId,{adminOnly=false}={})=>{
  const button=form.querySelector('[type=submit]');button.disabled=true;
  try{
    const r=await api('auth/login',{email:val(form,'email'),password:val(form,'password')});
    if(adminOnly&&r.role!=='admin'){await api('auth/logout',{}).catch(()=>{});throw Error('Admin access only. Use the client/vendor sign-in for workspace accounts.')}
    route(r.role);
  }catch(err){message(msgId,err.message)}finally{button.disabled=false}
};
if(document.body.dataset.page==='signup.html')for(const role of ['client','vendor']){
  const form=document.getElementById(role+'Form');form?.addEventListener('submit',async e=>{
    e.preventDefault();const prefix=role==='vendor'?'v':'',password=val(form,prefix?'vPassword':'password');
    const confirm=val(form,prefix?'vConfirmPassword':'confirmPassword');
    if(password!==confirm)return message(role+'FormMsg','Passwords do not match.');
    const button=form.querySelector('[type=submit]');button.disabled=true;
    try{const result=await api('auth/register',{role,email:val(form,prefix?'vEmail':'email'),password,company_name:val(form,prefix?'vCompanyName':'companyName'),contact_name:val(form,prefix?'vContactPerson':'contactPerson'),phone:val(form,prefix?'vPhone':'phone'),trade_license_no:val(form,'tradeLicenseNumber'),license_expiry:val(form,'tradeLicenseExpiry'),categories:[...form.querySelectorAll('[name=categories]:checked')].map(x=>x.value),emirate:val(form,'emirate'),accept_vendor_terms:role==='vendor'&&form.elements.clickwrapAccept.checked});
      form.reset();message(role+'FormMsg',result.emailSent?'Account created. Check your email to verify it before signing in.':'Account created. Email verification is pending while Zoho is connected; the Urban Procures team can verify your account manually.',true);
    }catch(err){message(role+'FormMsg',err.message)}finally{button.disabled=false}
  });
}
if(document.body.dataset.page==='signin.html'){
  document.getElementById('signInForm')?.addEventListener('submit',async e=>{e.preventDefault();await login(e.currentTarget,'signInMsg')});
  document.getElementById('forgotToggle')?.addEventListener('click',()=>document.getElementById('forgotPanel').hidden=false);
  document.getElementById('forgotForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await api('auth/reset/request',{email:val(e.currentTarget,'forgotEmail')});message('forgotMsg','If that email has an account, a reset link has been sent.',true)}catch(err){message('forgotMsg',err.message)}});
}
if(document.body.dataset.page==='admin-login.html'){
  document.getElementById('adminSignInForm')?.addEventListener('submit',async e=>{e.preventDefault();await login(e.currentTarget,'adminSignInMsg',{adminOnly:true})});
  document.getElementById('adminForgotToggle')?.addEventListener('click',()=>document.getElementById('adminForgotPanel').hidden=false);
  document.getElementById('adminForgotForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await api('auth/reset/request',{email:val(e.currentTarget,'forgotEmail')});message('adminForgotMsg','If that admin email exists, a reset link has been sent.',true)}catch(err){message('adminForgotMsg',err.message)}});
}
if(document.body.dataset.page==='reset-password.html')document.getElementById('resetPasswordForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,p=val(f,'newPassword');if(p!==val(f,'confirmNewPassword'))return message('resetMsg','Passwords do not match.');try{await api('auth/reset/confirm',{token:new URLSearchParams(location.search).get('token'),password:p});message('resetMsg','Password changed. You can sign in now.',true)}catch(err){message('resetMsg',err.message)}});
if(location.pathname==='/verify-email'){const token=new URLSearchParams(location.search).get('token');const p=document.createElement('main');p.className='auth-content';p.innerHTML='<h1>Verify your email</h1><p id="verifyMessage" role="status">Checking your link…</p><a href="/signin">Sign in</a>';document.body.replaceChildren(p);if(token)api('auth/verify',{token}).then(()=>p.querySelector('#verifyMessage').textContent='Email verified. You can sign in.').catch(e=>p.querySelector('#verifyMessage').textContent=e.message);else p.querySelector('#verifyMessage').textContent='Verification link is missing.'}
