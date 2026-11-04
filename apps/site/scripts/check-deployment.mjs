import assert from 'node:assert/strict'

const base = new URL(process.argv[2] || 'http://localhost:4173')
const request = (path, options = {}) => fetch(new URL(path, base), { redirect: 'manual', ...options })

for (const path of [
  '/',
  '/download',
  '/privacy',
  '/robots.txt',
  '/sitemap.xml',
  '/wordmark.svg',
  '/fonts/manrope-latin.woff2',
]) {
  const response = await request(path)
  assert.equal(response.status, 200, path)
}

for (const path of ['/buy', '/license', '/thanks']) {
  const response = await request(`${path}?source=migration-check`)
  assert.equal(response.status, 308, path)
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/download')
  assert.equal(new URL(response.headers.get('location'), base).search, '?source=migration-check')
}

for (const [headers, locale] of [
  [{ 'accept-language': 'nl-NL,nl;q=0.9' }, 'nl'],
  [{ cookie: 'remember-locale=nl', 'accept-language': 'en' }, 'nl'],
  [{ cookie: 'remember-locale=en', 'accept-language': 'nl' }, 'en'],
  [{ cookie: 'remember-locale=invalid', 'accept-language': 'en' }, 'en'],
]) {
  const response = await request('/', { headers })
  const html = await response.text()
  assert.ok(html.includes(`lang="${locale}"`), `locale ${locale}`)
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=63072000')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()')
  assert.ok(html.includes('https://github.com/janrtvld/remember/releases/latest/download/Remember-arm64.dmg'))
  assert.ok(!html.includes('/_vercel/'), 'Vercel analytics removed')
  assert.ok(!response.headers.has('x-vercel-id'), 'request served independently of Vercel')
  assert.match(
    response.headers.get('cache-control') || '',
    /private|no-store/,
    'locale response must not be shared-cacheable'
  )
}
assert.equal((await request('/migration-not-found')).status, 404)

// Host headers are rewritten by the local Vite preview proxy; check the real apex after cutover.
if (base.hostname === 'www.remember.computer') {
  const response = await fetch('https://remember.computer/privacy?source=migration-check', { redirect: 'manual' })
  assert.equal(response.status, 308)
  assert.equal(response.headers.get('location'), 'https://www.remember.computer/privacy?source=migration-check')
}
console.log(`Deployment checks passed: ${base.origin}`)
