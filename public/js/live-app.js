import {
  supabase,
  signIn,
  signUp,
  signOut,
  getUser,
  getDesk,
  goDesk,
  ADMIN_EMAIL,
  isAdminEmail,
  resetPassword,
  updatePassword,
  completePasswordRecovery,
  apiRequest,
  friendlyAuthError,
  accessToken
} from '../../src/supabase/client.js'

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => '&#' + ({ '&': 38, '<': 60, '>': 62, '"': 34, "'": 39 }[c]) + ';')
}

function navigateTo(page) {
  const raw = !page || page === 'home' ? 'index' : String(page)
  const [namePart, hash] = raw.split('#')
  const name = namePart.replace(/\.html$/i, '') || 'index'
  window.location.href = (window.urbanRoute?.(name) || '/' + name) + (hash ? '#' + hash : '')
}
window.navigateTo = navigateTo

function fileName() {
  return document.body.dataset.page || (location.pathname.split('/').pop() || 'index.html').toLowerCase()
}

if (/^dashboard-(client|vendor|admin)\.html$/i.test(fileName())) {
  if (!document.getElementById('roleCoverStyle')) {
    const cover = document.createElement('style')
    cover.id = 'roleCoverStyle'
    cover.textContent = 'body > .dashboard { visibility: hidden !important }'
    document.documentElement.appendChild(cover)
  }
}

function uncoverDesk() {
  document.getElementById('roleCoverStyle')?.remove()
}

async function requireDesk(expected) {
  const desk = await getDesk()
  if (!desk.user) {
    navigateTo('signin')
    return null
  }
  if (desk.role !== expected) {
    goDesk(desk.role)
    return null
  }
  uncoverDesk()
  return desk
}

const DESK_TITLES = {
  admin: {
    dashboard: ['Admin Dashboard', 'Urban Procures Management'],
    vendors: ['Vendor Verification', 'Approve or reject licence checks'],
    users: ['Users', 'Clients and vendors on the platform'],
    rfqs: ['RFQs', 'Process requests into work packs — address stays here'],
    awards: ['Awards', 'Awarded work'],
    invoices: ['Invoices', 'Platform fee recorded on award'],
    stats: ['Platform Stats', 'Live desk counts'],
    settings: ['Settings', 'Admin desk lock and live wiring']
  },
  client: {
    dashboard: [null, 'Client Dashboard'],
    projects: [null, 'My Projects'],
    rfqs: [null, 'My RFQs'],
    quotes: [null, 'Quotes received'],
    messages: [null, 'Messages'],
    settings: [null, 'Settings']
  },
  vendor: {
    dashboard: [null, 'Vendor Dashboard'],
    invites: [null, 'RFQ Invitations'],
    quotes: [null, 'My Quotes'],
    awards: [null, 'Awards'],
    stock: [null, 'Stock Codes'],
    messages: [null, 'Messages'],
    settings: [null, 'Settings']
  }
}

function bindDeskTabs(role) {
  const tabs = document.querySelectorAll('[data-desk-tab]')
  if (!tabs.length) return
  const titles = DESK_TITLES[role] || {}
  const show = (name) => {
    if (!document.querySelector(`[data-desk-panel="${name}"]`)) return
    document.querySelectorAll('[data-desk-tab]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-desk-tab') === name)
    })
    document.querySelectorAll('[data-desk-panel]').forEach((p) => {
      p.hidden = p.getAttribute('data-desk-panel') !== name
    })
    const pair = titles[name]
    if (pair) {
      if (pair[0]) {
        const h1 = document.getElementById('deskTitle') || document.querySelector('.dash-header h1')
        if (h1) h1.textContent = pair[0]
      }
      if (pair[1]) {
        const sub = document.getElementById('deskSub')
        if (sub) {
          const badge = sub.querySelector('.badge')
          sub.innerHTML = pair[1] + (badge ? ' · ' + badge.outerHTML : '')
        }
      }
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name)
  }
  document.querySelector('.dash-sidebar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-desk-tab]')
    if (!btn) return
    e.preventDefault()
    show(btn.getAttribute('data-desk-tab'))
  })
  document.querySelector('.dash-main')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-desk-tab]')
    if (!btn) return
    e.preventDefault()
    show(btn.getAttribute('data-desk-tab'))
  })
  const initial = (location.hash || '').replace('#', '')
  if (initial && document.querySelector(`[data-desk-panel="${initial}"]`)) show(initial)
  else show('dashboard')
  window.addEventListener('hashchange', () => {
    const name = (location.hash || '').replace('#', '') || 'dashboard'
    show(name)
  })
}

function trackingCode() {
  const a = Math.random().toString(36).slice(2, 6).toUpperCase()
  const b = Date.now().toString(36).slice(-4).toUpperCase()
  return `UP-${a}${b}`
}

function fmtDate(d) {
  if (!d) return '—'
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return esc(d)
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtAed(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  return 'AED ' + x.toLocaleString('en-AE', { maximumFractionDigits: 0 })
}

function relTime(d) {
  if (!d) return '—'
  const t = new Date(d).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' hours ago'
  if (s < 172800) return '1 day ago'
  return Math.floor(s / 86400) + ' days ago'
}

function statusBadge(status) {
  const s = String(status || '')
  const cls = /award|selected|verified|issued|published/i.test(s) ? 'awarded'
    : /review|pending|match|verif|quot|compar|invit/i.test(s) ? 'pending'
    : /close|withdraw|reject|overdue|suspend/i.test(s) ? 'overdue'
    : /paid/i.test(s) ? 'paid'
    : 'open'
  return `<span class="badge ${cls}">${esc(s)}</span>`
}

function fillTable(table, rows, emptyCols, emptyText) {
  if (!table) return
  const tb = table.querySelector('tbody')
  if (!tb) return
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="${emptyCols}">${esc(emptyText || 'No records yet.')}</td></tr>`
    return
  }
  tb.innerHTML = rows.join('')
}

function cityLabel(v) {
  const map = {
    dubai: 'Dubai',
    'abu-dhabi': 'Abu Dhabi',
    sharjah: 'Sharjah',
    ajman: 'Ajman',
    rak: 'Ras Al Khaimah',
    fujairah: 'Fujairah',
    uaq: 'Umm Al Quwain'
  }
  return map[String(v || '').toLowerCase()] || v || 'Dubai'
}

function waLink(text) {
  return 'https://wa.me/971507335567?text=' + encodeURIComponent(text)
}

function chips(list) {
  const items = Array.isArray(list) ? list : String(list || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!items.length) return '—'
  return items.map((c) => `<span class="chip">${esc(c)}</span>`).join(' ')
}

function setMsg(el, text, kind) {
  if (!el) return
  el.hidden = !text
  el.className = 'form-msg' + (kind ? ' ' + kind : '')
  el.textContent = text || ''
}

function parseGuest(rfq) {
  const text = String(rfq?.special_requirements || '')
  const pick = (key) => {
    const m = text.match(new RegExp('(?:^|\\n)' + key + ':\\s*(.+)$', 'im'))
    return m ? m[1].trim() : ''
  }
  return {
    name: pick('name') || rfq.guest_full_name || '',
    phone: pick('phone') || rfq.guest_phone || '',
    email: pick('email') || rfq.guest_email || '',
    tracking: pick('tracking') || rfq.tracking_code || rfq.id,
    visit: pick('visit')
  }
}

function ownerLabel(rfq) {
  const guest = parseGuest(rfq)
  return guest.name || guest.email || 'Registered client'
}

async function initCounters() {
  const home = document.getElementById('awardedFeed') || document.getElementById('regCount')
  if (!home && !document.getElementById('vendorGrid')) return
  if (document.getElementById('vendorGrid') && /vendors\.html$/i.test(fileName())) {
    await wireVendorsPage()
  }
  if (!document.getElementById('regCount') && !document.getElementById('awardedFeed')) return
  try {
    const stats = await apiRequest('/api/public/stats', { auth: false })
    fillHome(stats)
    if (document.getElementById('trustedGrid')) {
      const pack = await apiRequest('/api/public/vendors', { auth: false }).catch(() => ({ vendors: [] }))
      fillTrusted(pack.vendors || [])
    }
  } catch {
    fillHome({
      vendors: 0, companies: 0, rfqs: 0, awards: 0, quotes: 0, volume: 0,
      openRfqs: 0, closingThisWeek: 0, topCategory: '', categories: [], awardsFeed: [], activity: []
    })
  }
}

function fillHome(stats) {
  const setText = (id, value) => {
    const el = document.getElementById(id)
    if (el) el.textContent = value
  }
  setText('regCount', String(stats.companies || 0))
  setText('awardCount', String(stats.awards || 0))
  setText('vendorCount', String(stats.vendors || 0))
  setText('volumeCount', fmtAed(stats.volume || 0))
  setText('pulseOpen', String(stats.openRfqs || 0))
  setText('pulseClosing', String(stats.closingThisWeek || 0))
  setText('pulseQuotes', String(stats.quotes || 0))
  setText('insightRfqs', String(stats.rfqs || 0))
  setText('insightAwards', String(stats.awards || 0))
  setText('insightCategory', stats.topCategory || '—')
  setText('insightVendors', String(stats.vendors || 0))

  const feed = document.getElementById('awardedFeed')
  if (feed) {
    const rows = stats.awardsFeed || []
    feed.innerHTML = rows.length
      ? rows.map((row) => `<div class="awarded-item">
          <div class="icon">🏗</div>
          <div class="details">
            <strong>${esc(row.category || 'Awarded work')}</strong>
            <span>Identities stay with the desk</span>
          </div>
          <div class="meta">${esc(relTime(row.created_at))}</div>
        </div>`).join('')
      : '<p class="empty-note">No awards yet. The first awarded work pack will appear here — without client or vendor names.</p>'
  }

  const ticker = document.getElementById('activityTicker')
  if (ticker) {
    const rows = stats.activity || []
    ticker.innerHTML = rows.length
      ? rows.map((row) => `<div class="ticker-item"><span class="time">${esc(relTime(row.created_at))}</span><span class="action">${esc(row.event)}</span></div>`).join('')
      : '<p class="empty-note">Activity appears here as RFQs, quotes, and awards move through the desk. Company names stay off this feed.</p>'
  }

  const heat = document.getElementById('categoryHeatmap')
  if (heat) {
    const rows = stats.categories || []
    heat.innerHTML = rows.length
      ? rows.slice(0, 6).map((row) => `<div class="heatmap-row">
          <span>${esc(row.name)}</span>
          <div class="heatmap-bar" style="width:${Math.max(8, Number(row.pct) || 0)}%"></div>
          <strong>${esc(row.pct)}%</strong>
        </div>`).join('')
      : '<p class="empty-note">Category mix appears once RFQs are posted.</p>'
  }
}

function initials(name) {
  return String(name || 'UP').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

function fillTrusted(vendors) {
  const grid = document.getElementById('trustedGrid')
  const chip = document.getElementById('trustedChip')
  if (chip) chip.textContent = `${vendors.length} verified`
  if (!grid) return
  if (!vendors.length) {
    grid.innerHTML = '<p class="empty-note">Verified vendor companies appear here after licence checks. Contact details stay off this page.</p>'
    return
  }
  grid.innerHTML = vendors.slice(0, 12).map((v) => {
    const name = v.company_name || v.trading_name || 'Verified vendor'
    return `<div class="trusted-logo"><div class="avatar">${esc(initials(name))}</div> ${esc(name)}</div>`
  }).join('')
}

async function wireVendorsPage() {
  const grid = document.getElementById('vendorGrid')
  if (!grid) return
  let list = []
  try {
    const pack = await apiRequest('/api/public/vendors', { auth: false })
    list = pack.vendors || []
  } catch {
    list = []
  }

  const paint = () => {
    const q = (document.getElementById('searchVendor')?.value || '').trim().toLowerCase()
    const cat = (document.getElementById('filterCategory')?.value || '').trim().toLowerCase()
    const filtered = list.filter((v) => {
      const name = `${v.company_name || ''} ${v.trading_name || ''}`.toLowerCase()
      const cats = (v.categories || []).map((c) => String(c).toLowerCase())
      if (q && !name.includes(q)) return false
      if (cat && !cats.includes(cat)) return false
      return true
    })
    if (!filtered.length) {
      grid.innerHTML = `<p class="empty-note">${list.length ? 'No verified vendors match that filter.' : 'No verified vendors yet. Register as a vendor and our team will review your licence.'}</p>`
      return
    }
    grid.innerHTML = filtered.map((v) => {
      const name = v.company_name || v.trading_name || 'Verified vendor'
      return `<div class="panel vendor-card">
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem">
          <div style="width:3rem;height:3rem;border-radius:10px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:800">${esc(initials(name))}</div>
          <div>
            <strong style="font-size:.95rem">${esc(name)}</strong>
            <p class="muted" style="font-size:.78rem">${esc(v.emirate || 'UAE')}</p>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.75rem">${chips(v.categories)}</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="badge verified">Verified</span>
          <button class="tiny" type="button" onclick="navigateTo('signup')">Join as vendor</button>
        </div>
      </div>`
    }).join('')
  }

  document.getElementById('searchVendor')?.addEventListener('input', paint)
  document.getElementById('filterCategory')?.addEventListener('change', paint)
  document.getElementById('filterStatus')?.addEventListener('change', paint)
  paint()
}

function initStickyFooter() {
  const sticky = document.getElementById('sticky')
  if (!sticky) return
  window.addEventListener('scroll', () => {
    sticky.style.display = window.scrollY > 400 ? 'flex' : 'none'
  })
}

function initMobileMenu() {
  const menuBtn = document.getElementById('menuBtn')
  const app = document.getElementById('app')
  if (menuBtn && app) menuBtn.addEventListener('click', () => app.classList.toggle('nav-open'))
  const dash = document.querySelector('.dashboard')
  if (!dash) return
  if (!document.getElementById('dashMenuBtn')) {
    const header = dash.querySelector('.dash-header')
    const btn = document.createElement('button')
    btn.id = 'dashMenuBtn'
    btn.className = 'menu'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Open navigation')
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    header?.prepend(btn)
    btn.addEventListener('click', () => dash.classList.toggle('nav-open'))
  }
}

function initCookieBanner() {
  const cookie = document.getElementById('cookie')
  if (!cookie) return
  cookie.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => { cookie.hidden = true })
  })
}

function handleClickwrap() {
  const checkbox = document.getElementById('clickwrapAccept')
  const submitBtn = document.getElementById('submitRegistration')
  if (!checkbox || !submitBtn) return
  checkbox.addEventListener('change', () => { submitBtn.disabled = !checkbox.checked })
}

function selectRole(role) {
  const step1 = document.getElementById('step1')
  const step2Client = document.getElementById('step2Client')
  const step2Vendor = document.getElementById('step2Vendor')
  if (!step1) return
  step1.style.display = 'none'
  if (step2Client) step2Client.style.display = role === 'client' ? 'block' : 'none'
  if (step2Vendor) step2Vendor.style.display = role === 'vendor' ? 'block' : 'none'
}

function goBack() {
  const step1 = document.getElementById('step1')
  const step2Client = document.getElementById('step2Client')
  const step2Vendor = document.getElementById('step2Vendor')
  if (step1) step1.style.display = 'block'
  if (step2Client) step2Client.style.display = 'none'
  if (step2Vendor) step2Vendor.style.display = 'none'
}

function bindSignOut() {
  document.querySelectorAll('.dash-sidebar button').forEach((btn) => {
    if (!/sign out/i.test(btn.textContent || '')) return
    btn.onclick = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      await signOut()
      navigateTo('index')
    }
  })
}

function ensureModal() {
  let el = document.getElementById('deskModal')
  if (el) return el
  el = document.createElement('dialog')
  el.id = 'deskModal'
  el.className = 'modal'
  el.innerHTML = '<div class="modal-inner panel" id="deskModalInner"></div>'
  document.body.appendChild(el)
  el.addEventListener('click', (e) => {
    if (e.target === el) el.close()
  })
  return el
}

function openModal(html) {
  const el = ensureModal()
  const inner = el.querySelector('#deskModalInner')
  inner.innerHTML = html
  if (typeof el.showModal === 'function') el.showModal()
  else el.setAttribute('open', '')
  inner.querySelector('[data-close-modal]')?.addEventListener('click', () => el.close())
  return inner
}

function closeModal() {
  const el = document.getElementById('deskModal')
  if (el?.open) el.close()
}

async function loadDeskSafe() {
  return apiRequest('/api/desk/bootstrap')
}

async function wirePublicChrome() {
  const name = fileName()
  if (/^dashboard-/i.test(name)) return
  if (name === 'reset-password.html') return
  const desk = await getDesk()
  if (!desk.user || !desk.role) return
  if (name === 'signin.html' || name === 'signup.html' || name === 'reset-password.html') {
    if (name !== 'reset-password.html') goDesk(desk.role)
    return
  }
  const label = desk.role === 'admin' ? 'Admin desk' : 'My desk'
  document.querySelectorAll('nav button, .row > .ghost, .rolebox .ghost').forEach((btn) => {
    const text = (btn.textContent || '').trim()
    if (/^sign in$/i.test(text)) {
      btn.textContent = label
      btn.onclick = (e) => {
        e.preventDefault()
        goDesk(desk.role)
      }
    }
  })
  const box = document.querySelector('.rolebox')
  if (box) {
    const strong = box.querySelector('strong')
    const p = box.querySelector('p')
    if (strong) strong.textContent = 'Signed in'
    if (p) p.textContent = 'Open your ' + (desk.role === 'admin' ? 'admin' : desk.role) + ' desk.'
  }
}

async function wireSignIn() {
  const form = document.getElementById('signInForm')
  if (!form) return
  const msg = document.getElementById('signInMsg')
  const existing = await getDesk()
  if (existing.user && existing.role) {
    goDesk(existing.role)
    return
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = form.querySelector('button[type="submit"]')
    if (btn) btn.disabled = true
    setMsg(msg, '', '')
    const email = document.getElementById('email').value.trim()
    const password = document.getElementById('password').value
    const { error } = await signIn(email, password)
    if (error) {
      if (btn) btn.disabled = false
      setMsg(msg, friendlyAuthError(error, email), 'error')
      return
    }
    const desk = await getDesk()
    goDesk(desk.role)
  })

  const forgotBtn = document.getElementById('forgotToggle')
  const forgotPanel = document.getElementById('forgotPanel')
  const forgotForm = document.getElementById('forgotForm')
  forgotBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    if (!forgotPanel) return
    forgotPanel.hidden = !forgotPanel.hidden
    const email = document.getElementById('email')?.value
    const forgotEmail = document.getElementById('forgotEmail')
    if (forgotEmail && email && !forgotEmail.value) forgotEmail.value = email
  })
  forgotForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const forgotMsg = document.getElementById('forgotMsg')
    const email = document.getElementById('forgotEmail').value.trim()
    const btn = forgotForm.querySelector('button[type="submit"]')
    if (btn) btn.disabled = true
    try {
      try {
        await apiRequest('/api/auth/recover', { method: 'POST', auth: false, body: { email, redirectTo: location.origin + '/reset-password' } })
      } catch {
        const { error } = await resetPassword(email)
        if (error) throw error
      }
      setMsg(forgotMsg, 'If that email has an account, we sent a reset link. Check inbox and spam.', 'ok')
    } catch (err) {
      setMsg(forgotMsg, friendlyAuthError(err, email), 'error')
    } finally {
      if (btn) btn.disabled = false
    }
  })
}

async function wireResetPassword() {
  const form = document.getElementById('resetPasswordForm')
  if (!form) return
  const msg = document.getElementById('resetMsg')
  const btn = form.querySelector('button[type="submit"]')
  let recoverySession = false
  if (btn) btn.disabled = true
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session) {
      recoverySession = true
      if (btn) btn.disabled = false
      setMsg(msg, 'Enter a new password for this account.', 'ok')
    }
  })
  const recovery = await completePasswordRecovery()
  recoverySession = Boolean(recovery.session)
  if (btn) btn.disabled = !recoverySession
  if (recoverySession) {
    setMsg(msg, 'Enter a new password for this account.', 'ok')
  } else if (recovery.error) {
    setMsg(msg, 'This reset link is invalid or expired. Request a new password reset email and open its latest link.', 'error')
  } else {
    setMsg(msg, 'Open the password reset link from your email to continue. If it has expired, request a new one.', 'error')
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!recoverySession) {
      setMsg(msg, 'Open a valid password reset link from your email before updating the password.', 'error')
      return
    }
    const password = document.getElementById('newPassword').value
    const confirm = document.getElementById('confirmNewPassword').value
    if (password.length < 8) {
      setMsg(msg, 'Password must be at least 8 characters.', 'error')
      return
    }
    if (password !== confirm) {
      setMsg(msg, 'Passwords do not match.', 'error')
      return
    }
    if (btn) btn.disabled = true
    const { error } = await updatePassword(password)
    if (error) {
      if (btn) btn.disabled = false
      setMsg(msg, friendlyAuthError(error), 'error')
      return
    }
    subscription?.unsubscribe()
    setMsg(msg, 'Password updated. Opening your desk…', 'ok')
    const desk = await getDesk()
    if (desk.user) goDesk(desk.role)
    else navigateTo('signin')
  })
}

async function wireSignup() {
  const clientForm = document.getElementById('clientForm')
  const vendorForm = document.getElementById('vendorForm')
  if (!clientForm && !vendorForm) return

  const existing = await getDesk()
  if (existing.user && existing.role) {
    goDesk(existing.role)
    return
  }

  if (clientForm) {
    clientForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const msg = document.getElementById('clientFormMsg')
      const password = document.getElementById('password')?.value
      const confirmPassword = document.getElementById('confirmPassword')?.value
      if (password !== confirmPassword) { setMsg(msg, 'Passwords do not match.', 'error'); return }
      const email = document.getElementById('email').value.trim()
      if (isAdminEmail(email)) {
        setMsg(msg, 'This email is reserved for the Urban Procures desk. Use Sign In.', 'error')
        return
      }
      const btn = clientForm.querySelector('button[type="submit"]')
      if (btn) btn.disabled = true
      const fields = {
        company_name: document.getElementById('companyName').value.trim(),
        contact_name: document.getElementById('contactPerson').value.trim(),
        phone: document.getElementById('phone').value.trim(),
        emirate: cityLabel(document.getElementById('emirate')?.value || document.getElementById('city')?.value || 'dubai'),
        company_type: document.getElementById('companyType')?.value || 'contractor'
      }
      const { data, error } = await signUp(email, password, {
        user_type: 'client',
        company_name: fields.company_name,
        contact_name: fields.contact_name,
        phone: fields.phone,
        emirate: fields.emirate
      })
      if (error) {
        if (btn) btn.disabled = false
        setMsg(msg, friendlyAuthError(error, email), 'error')
        return
      }
      try {
        if (data?.session || await accessToken()) {
          await apiRequest('/api/terms/accept', { method: 'POST', body: { doc_type: 'client_tnc', contact_email: email } })
          await apiRequest('/api/desk/client-profile', { method: 'POST', body: fields })
          goDesk('client')
          return
        }
      } catch (err) {
        if (btn) btn.disabled = false
        setMsg(msg, err.message, 'error')
        return
      }
      setMsg(msg, 'Account created. Sign in to open your client desk.', 'ok')
      navigateTo('signin')
    })
  }

  if (vendorForm) {
    vendorForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const msg = document.getElementById('vendorFormMsg')
      const password = document.getElementById('vPassword').value
      const confirmPassword = document.getElementById('vConfirmPassword').value
      if (password !== confirmPassword) { setMsg(msg, 'Passwords do not match.', 'error'); return }
      const email = document.getElementById('vEmail').value.trim()
      if (isAdminEmail(email)) {
        setMsg(msg, 'This email is reserved for the Urban Procures desk. Use Sign In.', 'error')
        return
      }
      const categories = Array.from(document.querySelectorAll('input[name="categories"]:checked')).map((cb) => cb.value)
      if (!categories.length) {
        setMsg(msg, 'Select at least one category.', 'error')
        return
      }
      const btn = vendorForm.querySelector('button[type="submit"]')
      if (btn) btn.disabled = true
      const fields = {
        company_name: document.getElementById('vCompanyName').value.trim(),
        contact_name: document.getElementById('vContactPerson').value.trim(),
        phone: document.getElementById('vPhone').value.trim(),
        trade_license_no: document.getElementById('tradeLicenseNumber').value.trim(),
        license_expiry: document.getElementById('tradeLicenseExpiry').value,
        categories,
        emirate: 'Dubai'
      }
      const { data, error } = await signUp(email, password, {
        user_type: 'vendor',
        company_name: fields.company_name,
        contact_name: fields.contact_name,
        phone: fields.phone
      })
      if (error) {
        if (btn) btn.disabled = false
        setMsg(msg, friendlyAuthError(error, email), 'error')
        return
      }
      try {
        if (data?.session || await accessToken()) {
          await apiRequest('/api/terms/accept', { method: 'POST', body: { doc_type: 'vendor_tnc', contact_email: email } })
          await apiRequest('/api/desk/vendor-profile', { method: 'POST', body: fields })
          goDesk('vendor')
          return
        }
      } catch (err) {
        if (btn) btn.disabled = false
        setMsg(msg, err.message, 'error')
        return
      }
      setMsg(msg, 'Vendor account created. Sign in — verification stays pending until we review the licence.', 'ok')
      navigateTo('signin')
    })
  }
}

async function wirePublicRfq() {
  const form = document.getElementById('publicRfqForm')
  if (!form) return

  const siteVisitYes = document.getElementById('siteVisitYes')
  const siteVisitNo = document.getElementById('siteVisitNo')
  const siteVisitDetails = document.getElementById('siteVisitDetails')
  const siteVisitYesLabel = document.getElementById('siteVisitYesLabel')
  const siteVisitNoLabel = document.getElementById('siteVisitNoLabel')
  const msg = document.getElementById('publicRfqMsg')

  function updateSiteVisit() {
    if (!siteVisitYes || !siteVisitDetails) return
    if (siteVisitYes.checked) {
      siteVisitDetails.style.display = 'block'
      if (siteVisitYesLabel) {
        siteVisitYesLabel.style.borderColor = 'var(--orange)'
        siteVisitYesLabel.style.background = '#fff8f0'
      }
      if (siteVisitNoLabel) {
        siteVisitNoLabel.style.borderColor = 'var(--line)'
        siteVisitNoLabel.style.background = 'transparent'
      }
    } else {
      siteVisitDetails.style.display = 'none'
      if (siteVisitNoLabel) {
        siteVisitNoLabel.style.borderColor = 'var(--orange)'
        siteVisitNoLabel.style.background = '#fff8f0'
      }
      if (siteVisitYesLabel) {
        siteVisitYesLabel.style.borderColor = 'var(--line)'
        siteVisitYesLabel.style.background = 'transparent'
      }
    }
  }
  siteVisitYes?.addEventListener('change', updateSiteVisit)
  siteVisitNo?.addEventListener('change', updateSiteVisit)
  updateSiteVisit()

  window.saveDraft = function saveDraft() {
    const data = Object.fromEntries(new FormData(form).entries())
    data.siteVisit = siteVisitYes?.checked ? 'yes' : 'no'
    localStorage.setItem('up_public_rfq_draft', JSON.stringify(data))
    setMsg(msg, 'Draft saved on this device. Come back and submit when ready.', 'ok')
  }

  const draft = localStorage.getItem('up_public_rfq_draft')
  if (draft) {
    try {
      const data = JSON.parse(draft)
      Object.keys(data).forEach((k) => {
        const el = form.elements[k] || document.getElementById(k)
        if (el && 'value' in el && data[k] != null && el.type !== 'file') el.value = data[k]
      })
      if (data.siteVisit === 'yes' && siteVisitYes) siteVisitYes.checked = true
      updateSiteVisit()
    } catch {}
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const submitBtn = form.querySelector('button[type="submit"]')
    if (submitBtn) submitBtn.disabled = true
    setMsg(msg, '', '')
    const siteVisit = !!siteVisitYes?.checked
    const code = trackingCode()
    const title = document.getElementById('workTitle').value.trim()
    const body = {
      id: code,
      tracking_code: code,
      title,
      category: document.getElementById('category').value,
      scope: document.getElementById('workDescription').value.trim(),
      emirate: cityLabel(document.getElementById('city').value),
      city: document.getElementById('city').value,
      address: document.getElementById('address').value.trim(),
      property_type: document.getElementById('propertyType').value,
      full_name: document.getElementById('fullName').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      email: document.getElementById('email').value.trim(),
      deadline: document.getElementById('deadline').value ? document.getElementById('deadline').value.slice(0, 10) : null,
      budget_min: document.getElementById('budgetMin')?.value || null,
      budget_max: document.getElementById('budgetMax')?.value || null,
      site_visit: siteVisit
    }
    try {
      const result = await apiRequest('/api/public/rfq', { method: 'POST', body, auth: true })
      localStorage.removeItem('up_public_rfq_draft')
      const tracking = result.tracking_code || code
      const wa = waLink('Get Quotes ' + tracking + ' — ' + title + (siteVisit ? ' (site visit AED 100)' : ''))
      const panel = form.closest('.panel') || form.parentElement
      if (panel) {
        panel.innerHTML = `
          <div style="display:grid;gap:1rem">
            <p class="eyebrow">${siteVisit ? 'Site visit requested' : 'RFQ submitted'}</p>
            <h3>${siteVisit ? 'Site visit request received — AED 100 pending' : 'Your request is in'}</h3>
            <p>Tracking code: <strong>${esc(tracking)}</strong></p>
            <p class="muted" style="font-size:.9rem">${
              siteVisit
                ? 'The AED 100 charge is not paid yet. Our team will arrange a legitimate payment method and appointment. Your RFQ stays with our desk until inspection and approval. Your contact details are not shown to vendors.'
                : 'Your name, phone, and property address stay with Urban Procures. Vendors see the work pack only — never the address — until you award.'
            }</p>
            <div class="row">
              <a class="btn" href="${wa}" target="_blank" rel="noopener">Message us on WhatsApp</a>
              <button type="button" class="ghost" onclick="location.reload()">Submit another</button>
            </div>
          </div>`
      }
    } catch (err) {
      if (submitBtn) submitBtn.disabled = false
      setMsg(msg, err.message || 'Could not submit this request.', 'error')
    }
  })
}

function quoteAmount(q) {
  return q.total ?? q.amount ?? q.awarded_amount
}

function fillMessages(id, notes) {
  const el = document.getElementById(id)
  if (!el) return
  const list = notes || []
  if (!list.length) {
    el.innerHTML = '<p class="muted">No desk messages yet. WhatsApp the team on +971 50 733 5567 if you need a human.</p>'
    return
  }
  el.innerHTML = `<table class="dash-table"><thead><tr><th>When</th><th>Message</th></tr></thead><tbody>${
    list.slice(0, 40).map((n) => `<tr><td>${esc(relTime(n.created_at))}</td><td>${esc(n.message)}</td></tr>`).join('')
  }</tbody></table>`
}

async function wireClientDesk() {
  if (!/dashboard-client/i.test(fileName())) return
  const desk = await requireDesk('client')
  if (!desk) return
  bindSignOut()
  bindDeskTabs('client')

  const paint = async () => {
    const boot = await loadDeskSafe()
    const profile = boot.profile || {}
    const name = profile.company_name || profile.contact_name || desk.user.email
    const h1 = document.querySelector('.dash-header h1')
    if (h1 && !location.hash.slice(1)) h1.textContent = 'Welcome back, ' + name
    const rfqs = boot.rfqs || []
    const quotes = boot.quotations || []
    const awards = boot.awards || []
    const disclosures = boot.disclosures || []
    const notes = boot.notifications || []
    const qByRfq = {}
    quotes.forEach((q) => { qByRfq[q.rfq_id] = (qByRfq[q.rfq_id] || 0) + 1 })
    const winnerName = (rfqId) => {
      const d = disclosures.find((x) => x.rfq_id === rfqId)
      return d?.winner?.company_name || d?.winner?.trading_name || 'Awarded vendor'
    }

    const cards = document.querySelectorAll('.dash-card strong')
    if (cards[0]) cards[0].textContent = String(rfqs.length)
    if (cards[1]) cards[1].textContent = String(rfqs.filter((r) => r.status !== 'Awarded' && r.status !== 'Closed' && r.status !== 'Withdrawn').length)
    if (cards[2]) cards[2].textContent = String(quotes.length)
    if (cards[3]) cards[3].textContent = String(awards.length)

    const rfqRows = rfqs.map((r) => `<tr>
      <td><strong>${esc(r.title)}</strong><div class="muted" style="font-size:.75rem">${esc(parseGuest(r).tracking)}</div></td>
      <td>${esc(r.project || 'Personal property')}</td>
      <td>${esc(r.category || '')}</td>
      <td>${fmtDate(r.deadline)}</td>
      <td>${qByRfq[r.id] || 0}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${(qByRfq[r.id] && r.status !== 'Awarded') ? `<button class="tiny solid" type="button" data-client="quotes" data-id="${esc(r.id)}">Quotes</button>` : ''}</td>
    </tr>`)
    const rfqRowsNoAction = rfqs.map((r) => `<tr>
      <td><strong>${esc(r.title)}</strong><div class="muted" style="font-size:.75rem">${esc(parseGuest(r).tracking)}</div></td>
      <td>${esc(r.project || 'Personal property')}</td>
      <td>${esc(r.category || '')}</td>
      <td>${fmtDate(r.deadline)}</td>
      <td>${qByRfq[r.id] || 0}</td>
      <td>${statusBadge(r.status)}</td>
    </tr>`)
    fillTable(document.getElementById('clientRfqsTable'), rfqRows, 7, 'No RFQs yet. Use Get Quotes — no extra registration needed.')
    fillTable(document.getElementById('clientProjectsTable'), rfqRowsNoAction, 6, 'No projects yet.')
    fillTable(document.getElementById('clientRfqsTable2'), rfqRowsNoAction, 6, 'No RFQs yet.')
    fillTable(document.getElementById('clientQuotesTable'), quotes.map((q) => {
      const rfq = rfqs.find((r) => r.id === q.rfq_id)
      const awarded = awards.some((a) => a.rfq_id === q.rfq_id)
      return `<tr>
        <td><strong>${esc(rfq?.title || q.rfq_id)}</strong></td>
        <td>${esc(awarded ? winnerName(q.rfq_id) : q.vendor_label)}</td>
        <td>${fmtAed(quoteAmount(q))}</td>
        <td>${statusBadge(q.status)}</td>
        <td>${awarded || rfq?.status === 'Awarded' ? '' : `<button class="tiny solid" type="button" data-client="award" data-rfq="${esc(q.rfq_id)}" data-quote="${esc(q.id)}">Award</button>`}</td>
      </tr>`
    }), 5, 'No quotes yet. They appear after vendors respond to a work pack.')

    fillTable(document.getElementById('clientAwardsTable'), awards.map((a) => {
      const rfq = rfqs.find((r) => r.id === a.rfq_id)
      return `<tr>
        <td><strong>${esc(rfq?.title || a.rfq_id)}</strong></td>
        <td>${esc(rfq?.category || '')}</td>
        <td>${fmtAed(a.awarded_amount)}</td>
        <td>${esc(winnerName(a.rfq_id))}</td>
        <td>${fmtDate(a.created_at)}</td>
        <td>${statusBadge('Awarded')}</td>
      </tr>`
    }), 6, 'No awards yet.')

    fillMessages('clientMessages', notes)

    const settings = document.getElementById('clientSettings')
    if (settings) {
      settings.innerHTML = `
        <form id="clientSettingsForm" class="stack-form">
          <div class="form-group"><label>Company</label><input name="company_name" value="${esc(profile.company_name || '')}" required /></div>
          <div class="form-group"><label>Contact</label><input name="contact_name" value="${esc(profile.contact_name || '')}" /></div>
          <div class="form-group"><label>Phone</label><input name="phone" value="${esc(profile.phone || '')}" /></div>
          <div class="form-group"><label>Email</label><input value="${esc(desk.user.email)}" disabled /></div>
          <p class="form-msg" id="clientSettingsMsg" hidden></p>
          <button class="btn" type="submit">Save profile</button>
        </form>`
      document.getElementById('clientSettingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const fd = new FormData(e.target)
        const sMsg = document.getElementById('clientSettingsMsg')
        try {
          await apiRequest('/api/desk/client-profile', {
            method: 'POST',
            body: {
              company_name: fd.get('company_name'),
              contact_name: fd.get('contact_name'),
              phone: fd.get('phone'),
              emirate: profile.emirate || 'Dubai'
            }
          })
          setMsg(sMsg, 'Saved.', 'ok')
        } catch (err) {
          setMsg(sMsg, err.message, 'error')
        }
      })
    }
    return { rfqs, quotes }
  }

  let state = await paint()
  document.querySelector('.dash-main')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-client]')
    if (!btn) return
    const kind = btn.getAttribute('data-client')
    if (kind === 'quotes') {
      const rfqId = btn.getAttribute('data-id')
      const rows = (state.quotes || []).filter((q) => q.rfq_id === rfqId)
      const rfq = (state.rfqs || []).find((r) => r.id === rfqId)
      openModal(`
        <header><h3>Quotes for ${esc(rfq?.title || rfqId)}</h3><button class="tiny" type="button" data-close-modal>Close</button></header>
        <p class="muted">Vendor names stay masked until you award.</p>
        ${rows.length ? rows.map((q) => `<div class="quote-row"><strong>${esc(q.vendor_label)}</strong><span>${fmtAed(quoteAmount(q))}</span><button class="tiny solid" type="button" data-client="award" data-rfq="${esc(rfqId)}" data-quote="${esc(q.id)}">Award</button></div>`).join('') : '<p class="muted">No quotes on this RFQ yet.</p>'}
      `)
      return
    }
    if (kind === 'award') {
      if (!confirm('Award this quote? Vendor identity is disclosed only after award.')) return
      btn.disabled = true
      try {
        await apiRequest(`/api/desk/rfqs/${encodeURIComponent(btn.getAttribute('data-rfq'))}/award`, {
          method: 'POST',
          body: { quotation_id: btn.getAttribute('data-quote') }
        })
        closeModal()
        state = await paint()
      } catch (err) {
        alert(err.message)
        btn.disabled = false
      }
    }
  })
}

async function wireVendorDesk() {
  if (!/dashboard-vendor/i.test(fileName())) return
  const desk = await requireDesk('vendor')
  if (!desk) return
  bindSignOut()
  bindDeskTabs('vendor')

  const paint = async () => {
    const boot = await loadDeskSafe()
    const profile = boot.profile || {}
    const name = profile.company_name || desk.user.email
    const status = profile.status || 'pending_verification'
    const verified = status === 'verified'
    const blocked = status === 'rejected' || status === 'suspended'
    const h1 = document.querySelector('.dash-header h1')
    if (h1 && !location.hash.slice(1)) h1.textContent = 'Welcome back, ' + name
    const badge = verified ? 'Verified' : (String(status).replace(/_/g, ' ') || 'Pending verification')
    const sub = document.querySelector('.dash-header .muted')
    if (sub) sub.innerHTML = `Vendor Dashboard · <span class="badge ${verified ? 'verified' : 'pending'}">${esc(badge)}</span>`

    const invitations = boot.invitations || []
    const rfqs = boot.rfqs || []
    const quotes = boot.quotations || []
    const awards = boot.awards || []
    const notes = boot.notifications || []
    const disclosures = boot.disclosures || []
    const pendingFee = awards.reduce((s, a) => s + Number(a.fee_amount || 0), 0)
    const rfqById = Object.fromEntries(rfqs.map((r) => [r.id, r]))

    const cards = document.querySelectorAll('.dash-card strong')
    if (cards[0]) cards[0].textContent = String(invitations.filter((i) => i.status !== 'declined' && i.status !== 'withdrawn').length)
    if (cards[1]) cards[1].textContent = String(quotes.length)
    if (cards[2]) cards[2].textContent = String(awards.length)
    if (cards[3]) cards[3].textContent = pendingFee ? fmtAed(pendingFee) : 'AED 0'

    const payPanel = document.getElementById('vendorPayPanel') || document.querySelector('.panel[style*="border-left"]')
    if (payPanel) {
      if (blocked) {
        const p = payPanel.querySelector('p')
        const strong = payPanel.querySelector('strong')
        if (strong) strong.textContent = status === 'rejected' ? 'Verification rejected' : 'Account suspended'
        if (p) p.textContent = 'This vendor desk cannot see work packs until Urban Procures restores access.'
        payPanel.style.display = ''
      } else if (!awards.length || !pendingFee) payPanel.style.display = 'none'
      else {
        payPanel.style.display = ''
        const p = payPanel.querySelector('p')
        if (p) p.innerHTML = `Recorded platform fee on your awards: <strong>${fmtAed(pendingFee)}</strong>. Pay via the Urban Procures desk on WhatsApp.`
      }
    }

    const openCount = invitations.filter((i) => i.status === 'invited' || i.status === 'viewed').length
    document.querySelectorAll('.chip.new, #vendorInvitesChip').forEach((chip) => {
      chip.textContent = openCount ? `${openCount} open` : 'None open'
    })

    const emptyInvites = blocked
      ? 'Access is blocked. Work packs stay hidden.'
      : verified
        ? 'No processed work packs yet. New RFQs stay with our desk until we issue a vendor pack — no names or addresses.'
        : 'Your account is pending verification. Processed work packs appear here after the team verifies your licence.'

    const inviteRows = rfqs.map((r) => `<tr>
      <td><strong>${esc(r.title)}</strong></td>
      <td>Masked</td>
      <td>${esc(r.category || '')}</td>
      <td>${fmtDate(r.deadline)}</td>
      <td>${statusBadge(r.status)}</td>
      <td><button class="tiny solid" type="button" data-vendor="view" data-id="${esc(r.id)}">View & quote</button></td>
    </tr>`)
    fillTable(document.getElementById('vendorInvitesTable'), inviteRows, 6, emptyInvites)
    fillTable(document.getElementById('vendorInvitesTable2'), inviteRows, 6, emptyInvites)

    fillTable(document.getElementById('vendorQuotesTable'), quotes.map((q) => `<tr>
      <td><strong>${esc(rfqById[q.rfq_id]?.title || q.rfq_id)}</strong></td>
      <td>Masked until award</td>
      <td>${fmtAed(quoteAmount(q))}</td>
      <td>—</td>
      <td>${statusBadge(q.status)}</td>
      <td></td>
    </tr>`), 6, 'No quotes submitted yet.')

    fillTable(document.getElementById('vendorAwardsTable'), awards.map((a) => {
      const d = disclosures.find((x) => x.rfq_id === a.rfq_id)
      const client = d?.client?.company_name || 'Disclosed on award'
      return `<tr>
        <td><strong>${esc(rfqById[a.rfq_id]?.title || a.rfq_id)}</strong></td>
        <td>${esc(client)}</td>
        <td>${fmtAed(a.awarded_amount)}</td>
        <td>${fmtAed(a.fee_amount)}</td>
        <td>${statusBadge(a.fee_amount ? 'Pending' : 'Waived')}</td>
        <td>${fmtDate(a.created_at)}</td>
      </tr>`
    }), 6, 'No awards yet.')

    const stock = document.getElementById('vendorStock')
    if (stock) {
      stock.innerHTML = awards.length
        ? `<table class="dash-table"><thead><tr><th>Award</th><th>Client</th><th>Reference</th></tr></thead><tbody>${
          awards.map((a) => {
            const d = disclosures.find((x) => x.rfq_id === a.rfq_id)
            return `<tr><td>${esc(rfqById[a.rfq_id]?.title || a.rfq_id)}</td><td>${esc(d?.client?.company_name || '—')}</td><td>${esc(a.id)}</td></tr>`
          }).join('')
        }</tbody></table>`
        : '<p class="muted">Stock codes open after an award.</p>'
    }

    fillMessages('vendorMessages', notes)

    const settings = document.getElementById('vendorSettings')
    if (settings) {
      settings.innerHTML = `
        <p class="muted" style="margin-bottom:.75rem">Status: ${esc(badge)}. Address is never in the work pack.</p>
        <form id="vendorSettingsForm" class="stack-form">
          <div class="form-group"><label>Company</label><input name="company_name" value="${esc(profile.company_name || '')}" required /></div>
          <div class="form-group"><label>Contact</label><input name="contact_name" value="${esc(profile.contact_name || '')}" /></div>
          <div class="form-group"><label>Phone</label><input name="phone" value="${esc(profile.phone || '')}" /></div>
          <div class="form-group"><label>Trade licence</label><input name="trade_license_no" value="${esc(profile.trade_license_no || '')}" required /></div>
          <div class="form-group"><label>Licence expiry</label><input type="date" name="license_expiry" value="${esc((profile.license_expiry || '').slice(0, 10))}" required /></div>
          <p class="form-msg" id="vendorSettingsMsg" hidden></p>
          <button class="btn" type="submit">Save profile</button>
        </form>`
      document.getElementById('vendorSettingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault()
        const fd = new FormData(e.target)
        const sMsg = document.getElementById('vendorSettingsMsg')
        try {
          await apiRequest('/api/desk/vendor-profile', {
            method: 'POST',
            body: {
              company_name: fd.get('company_name'),
              contact_name: fd.get('contact_name'),
              phone: fd.get('phone'),
              trade_license_no: fd.get('trade_license_no'),
              license_expiry: fd.get('license_expiry'),
              categories: profile.categories || [],
              emirate: profile.emirate || 'Dubai'
            }
          })
          setMsg(sMsg, 'Saved. Verification status is unchanged until the desk reviews it.', 'ok')
        } catch (err) {
          setMsg(sMsg, err.message, 'error')
        }
      })
    }
    return { rfqs }
  }

  let state = await paint()
  document.querySelector('.dash-main')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-vendor]')
    if (!btn) return
    if (btn.getAttribute('data-vendor') !== 'view') return
    const rfq = (state.rfqs || []).find((r) => r.id === btn.getAttribute('data-id'))
    if (!rfq) return
    const inner = openModal(`
      <header><h3>${esc(rfq.title)}</h3><button class="tiny" type="button" data-close-modal>Close</button></header>
      <p class="muted">${esc(rfq.category || '')} · ${esc(rfq.emirate || '')} · deadline ${fmtDate(rfq.deadline)}</p>
      <p>${esc(rfq.scope || 'Processed work pack. Client name, phone and address are not included.')}</p>
      <form id="quoteForm" class="stack-form">
        <div class="form-group"><label>Quote total (AED) *</label><input name="total" type="number" min="1" step="0.01" required /></div>
        <div class="form-group"><label>Completion period</label><input name="completion_period" placeholder="e.g. 14 days" /></div>
        <div class="form-group"><label>Notes</label><textarea name="notes" rows="3"></textarea></div>
        <p class="form-msg" id="quoteMsg" hidden></p>
        <button class="btn" type="submit">Submit quote</button>
      </form>
    `)
    inner.querySelector('#quoteForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault()
      const fd = new FormData(ev.target)
      const qMsg = document.getElementById('quoteMsg')
      const submit = ev.target.querySelector('button[type="submit"]')
      if (submit) submit.disabled = true
      try {
        await apiRequest(`/api/desk/rfqs/${encodeURIComponent(rfq.id)}/quote`, {
          method: 'POST',
          body: {
            total: Number(fd.get('total')),
            completion_period: fd.get('completion_period'),
            notes: fd.get('notes')
          }
        })
        closeModal()
        state = await paint()
      } catch (err) {
        setMsg(qMsg, err.message, 'error')
        if (submit) submit.disabled = false
      }
    })
  })
}

async function wireAdminDesk() {
  if (!/dashboard-admin/i.test(fileName())) return
  const desk = await requireDesk('admin')
  if (!desk) return
  const h1 = document.querySelector('.dash-header h1')
  if (h1) h1.textContent = 'Admin Dashboard'
  bindSignOut()
  bindDeskTabs('admin')

  const paint = async () => {
    const boot = await loadDeskSafe()
    const vList = boot.vendors || []
    const cList = boot.clients || []
    const rList = boot.rfqs || []
    const aList = boot.awards || []
    const qList = boot.quotations || []
    const notes = boot.notifications || []
    const pending = vList.filter((v) => v.status === 'pending_verification')
    const queue = rList.filter((r) => !r.sanitized_ready || r.review_state === 'awaiting_processing' || r.status === 'Under Review' || r.status === 'Submitted')
    const feeTotal = aList.reduce((s, a) => s + Number(a.fee_amount || 0), 0)
    const today = new Date().toISOString().slice(0, 10)
    const rfqsToday = rList.filter((r) => String(r.created_at || '').slice(0, 10) === today).length
    const awardsToday = aList.filter((a) => String(a.created_at || '').slice(0, 10) === today).length
    const month = new Date().toISOString().slice(0, 7)
    const monthFee = aList.filter((a) => String(a.created_at || '').slice(0, 7) === month).reduce((s, a) => s + Number(a.fee_amount || 0), 0)

    const cards = document.querySelectorAll('.dash-card strong')
    if (cards[0]) cards[0].textContent = String(cList.length + vList.length)
    if (cards[1]) cards[1].textContent = String(pending.length)
    if (cards[2]) cards[2].textContent = String(aList.length)
    if (cards[3]) cards[3].textContent = feeTotal ? fmtAed(feeTotal) : 'AED 0'

    const pendingLabel = pending.length ? `${pending.length} pending` : 'None pending'
    const pendingChip = document.getElementById('pendingChip')
    const pendingChip2 = document.getElementById('pendingChipVendors')
    if (pendingChip) pendingChip.textContent = pendingLabel
    if (pendingChip2) pendingChip2.textContent = pendingLabel
    const usersChip = document.getElementById('usersChip')
    if (usersChip) usersChip.textContent = String(cList.length + vList.length)

    const vendorAction = (v) => {
      if (v.status === 'pending_verification') {
        return `<button class="tiny" style="background:#d4edda;color:#155724" type="button" data-admin="approve" data-id="${esc(v.id)}">Approve</button>
      <button class="tiny" style="background:#f8d7da;color:#721c24" type="button" data-admin="reject" data-id="${esc(v.id)}">Reject</button>`
      }
      if (v.status === 'verified') {
        return `<button class="tiny" type="button" data-admin="suspend" data-id="${esc(v.id)}">Suspend</button>`
      }
      return `<button class="tiny" style="background:#d4edda;color:#155724" type="button" data-admin="approve" data-id="${esc(v.id)}">Restore</button>`
    }
    const vendorRows = (list) => list.map((v) => `<tr>
      <td><strong>${esc(v.company_name)}</strong></td>
      <td>${esc(v.contact_name || v.contact_email || '—')}</td>
      <td>${esc(v.trade_license_no || '—')}</td>
      <td>${chips(v.categories)}</td>
      <td>${relTime(v.created_at || v.updated_at)}</td>
      <td>${vendorAction(v)}</td>
    </tr>`)
    fillTable(document.getElementById('adminPendingTable'), vendorRows(pending), 6, 'No vendors waiting for verification.')
    fillTable(document.getElementById('adminVendorsTable'), vendorRows(vList), 6, 'No vendor registrations yet.')

    const queueRows = queue.map((r) => {
      const guest = parseGuest(r)
      return `<tr>
        <td><strong>${esc(r.title)}</strong><div class="muted" style="font-size:.75rem">${esc(guest.tracking)}</div></td>
        <td>${esc(guest.name || guest.email || 'Registered client')}</td>
        <td>${esc(r.location || '—')}</td>
        <td>${esc(r.category || '')}</td>
        <td>${statusBadge(r.review_state || r.status)}</td>
        <td><button class="tiny solid" type="button" data-admin="issue" data-id="${esc(r.id)}">Issue work pack</button></td>
      </tr>`
    })
    fillTable(document.getElementById('adminRfqQueueTable'), queueRows, 6, 'No RFQs waiting. Guest requests land here until we issue a vendor pack with no identity.')
    fillTable(document.getElementById('adminRfqQueueTable2'), queueRows, 6, 'No RFQs waiting. Guest requests land here until we issue a vendor pack with no identity.')

    const clientName = (id) => cList.find((c) => c.id === id)?.company_name || ownerLabel(rList.find((r) => r.client_id === id) || {}) || 'Client'
    const vendorName = (id) => vList.find((v) => v.id === id)?.company_name || 'Vendor'

    fillTable(document.getElementById('adminAwardsTable'), aList.map((a) => {
      const rfq = rList.find((r) => r.id === a.rfq_id)
      return `<tr>
        <td><strong>${esc(rfq?.title || a.rfq_id)}</strong></td>
        <td>${esc(clientName(rfq?.client_id))}</td>
        <td>${esc(vendorName(a.winner_vendor_id))}</td>
        <td>${fmtAed(a.awarded_amount)}</td>
        <td>${fmtAed(a.fee_amount)}</td>
        <td>${statusBadge(a.disclosed_at ? 'Recorded' : 'Pending')}</td>
      </tr>`
    }), 6, 'No awards yet.')

    fillTable(document.getElementById('adminInvoicesTable'), aList.map((a) => {
      const rfq = rList.find((r) => r.id === a.rfq_id)
      return `<tr>
        <td><strong>${esc(rfq?.title || a.rfq_id)}</strong></td>
        <td>${esc(vendorName(a.winner_vendor_id))}</td>
        <td>${fmtAed(a.awarded_amount)}</td>
        <td>${fmtAed(a.fee_amount)}</td>
        <td>${statusBadge(a.fee_amount ? 'Due' : 'Waived')}</td>
        <td>${fmtDate(a.created_at)}</td>
      </tr>`
    }), 6, 'No invoices yet. Fees appear when a job is awarded.')

    fillTable(document.getElementById('adminUsersTable'), [
      ...vList.map((v) => `<tr>
        <td><span class="chip">Vendor</span></td>
        <td><strong>${esc(v.company_name)}</strong></td>
        <td>${esc(v.contact_name || v.contact_email || '—')}</td>
        <td>${statusBadge(v.status)}</td>
        <td>${fmtDate(v.created_at || v.updated_at)}</td>
      </tr>`),
      ...cList.map((c) => `<tr>
        <td><span class="chip">Client</span></td>
        <td><strong>${esc(c.company_name)}</strong></td>
        <td>${esc(c.contact_name || c.phone || '—')}</td>
        <td>${statusBadge('Active')}</td>
        <td>${fmtDate(c.created_at)}</td>
      </tr>`)
    ], 5, 'No registered users yet.')

    fillTable(document.getElementById('adminAllRfqsTable'), rList.map((r) => {
      const guest = parseGuest(r)
      return `<tr>
        <td><strong>${esc(r.title)}</strong><div class="muted" style="font-size:.75rem">${esc(guest.tracking)}</div></td>
        <td>${esc(guest.name || clientName(r.client_id))}</td>
        <td>${esc(r.category || '')}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${r.sanitized_ready ? 'Issued' : 'Waiting'}</td>
        <td>${fmtDate(r.created_at)}</td>
      </tr>`
    }), 6, 'No RFQs yet.')

    const activity = document.getElementById('adminActivity')
    if (activity) {
      const rows = activity.querySelectorAll('strong')
      if (rows[0]) rows[0].textContent = String(cList.length + vList.length)
      if (rows[1]) rows[1].textContent = String(rfqsToday)
      if (rows[2]) rows[2].textContent = String(qList.length)
      if (rows[3]) rows[3].textContent = String(awardsToday)
    }
    const revenue = document.getElementById('adminRevenue')
    if (revenue) {
      const rows = revenue.querySelectorAll('strong')
      if (rows[0]) rows[0].textContent = feeTotal ? fmtAed(feeTotal) : 'AED 0'
      if (rows[1]) rows[1].textContent = monthFee ? fmtAed(monthFee) : 'AED 0'
      if (rows[2]) rows[2].textContent = feeTotal ? fmtAed(feeTotal) : 'AED 0'
      if (rows[3]) rows[3].textContent = 'AED 0'
    }

    const settingsLive = document.getElementById('adminSettingsLive')
    if (settingsLive) {
      settingsLive.innerHTML = `
        <p>This desk is locked to <strong>${esc(ADMIN_EMAIL)}</strong>. Client and vendor sign-ins cannot open it.</p>
        <p>Identity firewall stays on until award: vendors see only the processed work pack — never the name, phone, or property address.</p>
        <ul class="settings-list">
          <li>Sign up / sign in / forgot password — live</li>
          <li>Get Quotes guest RFQ — live, lands in the RFQ queue</li>
          <li>Vendor verification approve / reject — live</li>
          <li>Issue work pack + invite verified vendors — live</li>
          <li>Vendor quote + client award — live</li>
          <li>Platform fee recorded on award (2.5%, min AED 500 when billing is paid)</li>
          <li>WhatsApp desk: <a href="${waLink('Urban Procures desk')}" target="_blank" rel="noopener">+971 50 733 5567</a></li>
        </ul>`
    }
    fillMessages('adminMessages', notes)
    return boot
  }

  await paint()
  document.querySelector('.dash-main')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-admin]')
    if (!btn) return
    btn.disabled = true
    const kind = btn.getAttribute('data-admin')
    const id = btn.getAttribute('data-id')
    try {
      if (kind === 'approve') await apiRequest(`/api/desk/vendors/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: 'verified', note: 'Approved' } })
      else if (kind === 'reject') await apiRequest(`/api/desk/vendors/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: 'rejected', note: 'Rejected by Urban Procures' } })
      else if (kind === 'suspend') await apiRequest(`/api/desk/vendors/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status: 'suspended', note: 'Suspended' } })
      else if (kind === 'issue') await apiRequest(`/api/desk/rfqs/${encodeURIComponent(id)}/issue`, { method: 'POST', body: {} })
      await paint()
    } catch (err) {
      alert(err.message)
      btn.disabled = false
    }
  })
}

window.navigateTo = navigateTo
window.selectRole = selectRole
window.goBack = goBack
window.saveDraft = function saveDraft() {}
window.UrbanProcures = { navigateTo, supabase, ADMIN_EMAIL }

function bootPublicDesk() {
  initCounters()
  initStickyFooter()
  initMobileMenu()
  initCookieBanner()
  handleClickwrap()
  wirePublicChrome()
  wireSignIn()
  wireResetPassword()
  wireSignup()
  const signupRole = (location.hash || '').replace('#', '')
  if (signupRole === 'client' || signupRole === 'vendor') selectRole(signupRole)
  wirePublicRfq()
  wireClientDesk()
  wireVendorDesk()
  wireAdminDesk()
}

// app.js loads this file with a dynamic import, which resolves after DOMContentLoaded.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPublicDesk)
else bootPublicDesk()
