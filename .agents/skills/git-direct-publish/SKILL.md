---
name: git-direct-publish
description: Commit and push repository changes with Git directly. Use for every request to commit, push, publish, send, or update a Git branch or remote, including direct pushes to main. Do not substitute GitHub CLI authentication, a pull-request workflow, or a GitHub connector when the requested operation is a Git commit or push.
---

# Direct Git Publishing

Use the repository's configured Git remote and Git credential mechanism for commits and pushes. A `git push` request does not require `gh auth status`; Git and GitHub CLI authentication are separate.

## Workflow

1. Run `git status -sb`, inspect the complete diff, and identify the current branch or detached HEAD.
2. Confirm that every changed path belongs to the requested scope. Never stage unrelated changes.
3. Resolve the target ref from the user's request. If HEAD is detached, verify its relationship to the target with `git rev-parse` and `git merge-base` before committing.
4. Stage only the intended paths with `git add -- <paths>`.
5. Commit with a concise message describing the full staged diff.
6. Push with `git push` to the requested remote and branch. For a verified detached HEAD targeting `main`, use `git push origin HEAD:main`.
7. Report the commit hash and pushed ref only after Git confirms success.

## Boundaries

- Never run `gh auth status` merely to commit or push. It can incorrectly block a working Git credential helper.
- Use `gh` or a GitHub connector only when the user explicitly requests a pull request, issue, release, or another GitHub API operation.
- Never turn an explicit direct-to-main request into a feature branch or pull request.
- Never force-push unless the user explicitly requests it and the exact remote ref has been verified.
- If `git push` itself fails authentication, report that Git error and ask the user to repair the repository's Git credentials.
