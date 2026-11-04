# Remember website deployment

The public website runs as the `remember-site` Cloudflare Worker. Its only binding is static assets; it does not store app user data. The desktop app has no hosted backend. `cloudflare.config.ts` owns the deployment settings.

## Build and deploy

Run from the repository root with the Node version in `.node-version` and the pinned pnpm version:

```sh
pnpm install --filter @remember/site... --filter remember --frozen-lockfile
pnpm lint
pnpm --filter @remember/site types:check
pnpm --filter @remember/site build:vinext
pnpm --filter @remember/site start:vinext --port 4173
# In another terminal:
pnpm --filter @remember/site check:deployment http://localhost:4173
```

Sign in with `pnpm --filter @remember/site exec cf auth login`, then deploy:

```sh
pnpm --filter @remember/site exec cf deploy --dry-run
pnpm --filter @remember/site exec cf deploy --prebuilt
pnpm --filter @remember/site check:deployment https://remember-site.jan-d4f.workers.dev
```

`--prebuilt` deploys the last build, so run the build or dry run after changing code or Cloudflare configuration. Use `node --use-env-proxy apps/site/scripts/check-deployment.mjs URL` when the environment requires an HTTP proxy.

`pnpm --filter @remember/site dev:vinext` runs the Cloudflare development server on port 3001. The existing `dev`, `build`, and `start` scripts retain Next.js for transition/rollback. No root `.env` loading is needed: the canonical site defaults to `https://www.remember.computer`; an optional `SITE_URL` belongs in the site build environment.

The site uses vinext and the cf/Vite integration beta, with exact versions recorded in `pnpm-lock.yaml`. React, React DOM, and the React server transport are pinned together at 19.3.1. The desktop renderer remains on its existing React version. Do not independently upgrade the React transport package.

## Migration boundaries

| Surface | Before | Target / ownership |
| --- | --- | --- |
| Website HTML, assets, metadata, locale server action | Vercel | `remember-site` Worker |
| Apex redirect to `www` | Vercel domain setting | `proxy.ts` host redirect (preserves path and query) |
| Security headers | Next config + Vercel HSTS | Explicit Next config, consumed by both builders |
| Visits and performance | Vercel + Cloudflare | Explicit Cloudflare Web Analytics beacon using the existing site token |
| Custom download click events | Vercel Analytics | Removed by user decision; download links unchanged |
| Desktop renderer / local recordings | Packaged Electron / local storage | Unchanged |
| Downloads and desktop updater | GitHub Releases | Unchanged |

The website's only persistent write is the `remember-locale` browser cookie. Its name, values, HTTP-only flag, lifetime, and validation are preserved. Cookie precedence over Accept-Language and private/non-cacheable HTML are acceptance conditions. There is no website database to copy. Existing tabs may need a reload across the framework cutover because server-action identifiers and JS asset URLs change.

## Production cutover and rollback

The test deployment is at `https://remember-site.jan-d4f.workers.dev`. The production configuration attaches `remember.computer` and `www.remember.computer` as Worker custom domains. Verify the hosted site before applying these domain settings. Re-run the deployment checks against `https://www.remember.computer` after cutover; this additionally checks the real apex redirect. Check the language switch in a browser, page reload persistence, product preview, narrow viewport, and Cloudflare beacon injection.

Before migration, both website DNS records are proxied CNAMEs pointing to `6d55e1d2a8d3b0b3.vercel-dns-016.com`, TTL automatic (`1`), in zone `65eb46412179ed97af29d14237bbf4ba`:

- Apex record ID: `dcaf2952fbe8c69fc2134f2e9083189c`.
- `www` record ID: `01e71e6b6d84f2776a0c818f084f48ee`.

For immediate rollback, remove only the two website Worker custom-domain bindings, restore the two CNAMEs above, and remove those domains from the Worker config so a later deploy cannot undo rollback. Keep the existing Vercel deployment and project available during the transition. Verify page responses and locale switching on Vercel after restoring traffic. Do not change email records or GitHub Releases. Worker version rollback does not restore DNS or database data.

Vercel project deletion and account/subscription cancellation are separate cleanup actions; they are not part of the traffic switch.

## Automatic releases

`.github/workflows/site-cloudflare.yml` deploys pushes to `main` to production and pushes to other repository branches to isolated Cloudflare Previews. PRs from these branches share their branch preview. Fork PRs do not receive deployment credentials. The preview URL is printed in the GitHub Actions run summary. Branch previews remain until removed in Cloudflare.

GitHub Actions installs only the website and root tooling, runs lint and site type checks, then builds and deploys. Production additionally runs the hosted HTTP checks. Deployments are serialized per branch. All paths trigger builds because the website also imports components from `apps/web`.

The repository secret `CLOUDFLARE_SITE_API_TOKEN` is an account-owned Individual Workers Editor token scoped only to `remember-site`. Cloudflare native Workers Builds currently supports only user-owned tokens, which cannot have this granular scope, so GitHub Actions owns automation. The token cannot manage DNS, D1, or other Workers.

Production runs `pnpm --filter @remember/site deploy:ci`: it uploads and releases the exact version without changing domain bindings. The script parses the pinned cf CLI version ID and fails closed if its output changes. Infrastructure changes use the authenticated manual deployment command above. Previews use `cf previews deploy`, which creates preview-specific build output and never releases production traffic.
