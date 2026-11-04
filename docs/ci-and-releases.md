# CI and releases

Remember uses GitHub-hosted `macos-26` Apple Silicon runners. Both workflows are manually dispatched. Public pull requests do not execute on a maintainer's personal Mac or receive signing credentials.

## Validate a source revision

Open **Actions → CI → Run workflow** and select the branch to check. The workflow checks for Apple Silicon, the macOS 26 SDK or newer, and sufficient disk space, then installs the pinned Node.js and pnpm versions. It runs `pnpm validate` and `pnpm build` on the checked-out revision.

For local checks:

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm build
```

UI and native behavior still need the relevant [native verification](native-verification.md). A successful build alone is not a capture, permissions, or updater test.

## Publish a signed release

The **Publish Remember release** workflow runs only on `main`. Review the source commit and version before dispatching it. Workspace package versions must agree; the workflow verifies the approved version rather than inventing or incrementing one.

Configure these repository secrets for official distribution:

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID certificate archive |
| `CSC_KEY_PASSWORD` | Password for that certificate archive |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | Expected signing team |
| `SENTRY_AUTH_TOKEN` | Upload release source maps |

Open **Actions → Publish Remember release → Run workflow** on `main`. The workflow validates the selected source, imports the signing certificate into a temporary keychain, and prepares one signed and notarized set of artifacts. Publication rechecks and uploads those exact artifacts; it does not rebuild them.

Releases, tags, downloads, and the desktop updater use this repository, [`janrtvld/remember`](https://github.com/janrtvld/remember). Publication uses the workflow's `github.token` with `contents: write`; no cross-repository release token is required. Release notes and the provenance manifest identify the built source commit. Source maps go to Sentry, not the public download assets.

Local signed preparation and publication are separate commands:

```sh
pnpm package
pnpm --filter @remember/desktop release
```

Preparing official installers requires Apple signing and notarization credentials. Development with `pnpm dev:desktop` does not. Keep credentials in the runner's secrets or a protected local environment, never in source or command output.

## Verify publication

A successful dispatch is not a published release. Wait for the workflow to finish, check the recorded source commit and version, and inspect the release assets. Drafts and prereleases are not offered by the stable updater.

The complete update path—download, signature validation, quit-time installation, and relaunch—requires two signed and notarized versions served from the real release feed. Unit checks and package inspection do not establish that path.

The landing page has a separate Cloudflare deployment workflow; it hosts the website and does not store desktop app data. See [website deployment](../apps/site/README.md).
