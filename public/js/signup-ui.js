function selectRole(role) {
  if (role === 'contractor') role = 'client';
  var step1 = document.getElementById('step1');
  var step2Client = document.getElementById('step2Client');
  var step2Vendor = document.getElementById('step2Vendor');
  if (!step1) return;
  step1.style.display = 'none';
  if (step2Client) step2Client.style.display = role === 'client' ? 'block' : 'none';
  if (step2Vendor) step2Vendor.style.display = role === 'vendor' ? 'block' : 'none';
}
function goBack() {
  var step1 = document.getElementById('step1');
  var step2Client = document.getElementById('step2Client');
  var step2Vendor = document.getElementById('step2Vendor');
  if (step1) step1.style.display = 'block';
  if (step2Client) step2Client.style.display = 'none';
  if (step2Vendor) step2Vendor.style.display = 'none';
}
window.selectRole = selectRole;
window.goBack = goBack;
(function () {
  function sync(cid, bid) {
    var c = document.getElementById(cid);
    var b = document.getElementById(bid);
    if (!c || !b) return;
    var run = function () { b.disabled = !c.checked; };
    c.addEventListener('change', run);
    run();
  }
  sync('clientClickwrapAccept', 'submitClientRegistration');
  sync('clickwrapAccept', 'submitRegistration');
  function applyHashRole() {
    var hash = (location.hash || '').replace('#', '');
    if (hash === 'client' || hash === 'contractor' || hash === 'vendor') selectRole(hash);
  }
  applyHashRole();
  window.addEventListener('hashchange', applyHashRole);
})();
