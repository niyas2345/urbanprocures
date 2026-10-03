window.urbanTurnstileReady=async()=>{
  try{
    const response=await fetch('/api/native/public/config');if(!response.ok)throw Error('Verification is unavailable. Please retry.');
    const config=await response.json();
    window.turnstile.render('.cf-turnstile',{sitekey:config.turnstileSiteKey,theme:'light',action:'public_rfq'});
  }catch(error){const message=document.getElementById('publicRfqMsg');if(message){message.hidden=false;message.textContent=error.message}}
};
