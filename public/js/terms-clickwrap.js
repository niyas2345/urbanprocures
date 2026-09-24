function bindBox(boxId, btnId) {
  const checkbox = document.getElementById(boxId)
  const submitBtn = document.getElementById(btnId)
  if (!checkbox || !submitBtn) return
  submitBtn.disabled = !checkbox.checked
  checkbox.addEventListener('change', () => {
    submitBtn.disabled = !checkbox.checked
  })
}

bindBox('clickwrapAccept', 'submitRegistration')
bindBox('clientClickwrapAccept', 'submitClientRegistration')

document.addEventListener('submit', (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement)) return
  const clientBox = form.id === 'clientForm' ? document.getElementById('clientClickwrapAccept') : null
  const vendorBox = form.id === 'vendorForm' ? document.getElementById('clickwrapAccept') : null
  const box = clientBox || vendorBox
  if (!box) return
  if (box.checked) return
  e.preventDefault()
  e.stopImmediatePropagation()
  const msg = document.getElementById(form.id === 'clientForm' ? 'clientFormMsg' : 'vendorFormMsg')
  if (msg) {
    msg.hidden = false
    msg.className = 'form-msg error'
    msg.textContent = form.id === 'clientForm'
      ? 'Accept the Client Terms and Conditions to create an account.'
      : 'Accept the Vendor Terms and Conditions to create an account.'
  }
}, true)
