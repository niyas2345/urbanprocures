const page = document.body.dataset.page || (location.pathname.split('/').pop() || 'index.html').toLowerCase()
if (!/^dashboard-(client|vendor|admin)\.html$/i.test(page)) {
  import('./live-app.js').catch((err) => console.error(err))
  import('./terms-clickwrap.js').catch(() => {})
}
