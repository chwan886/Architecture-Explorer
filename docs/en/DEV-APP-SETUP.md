# Dedicated GitHub App development commands

[简体中文](../DEV-APP-SETUP.md) | [English](DEV-APP-SETUP.md)

This optional development tool verifies an App, pushes task branches, creates or updates PRs, and reads status. Running the explorer and analyzing source require no App. An explicit local configuration supplies the repository, App, installation, and key directory; no analyzed project or private delivery system is required.

## Configuration

Complete the Windows setup with PowerShell 7, Git, the Node version pinned in `toolchain.lock.json`, and dependencies. Copy the [template](../../config/dev-app.example.json) to ignored `config/dev-app.local.json`. Set your App ID, installation ID, App slug, single `owner/repository`, protected base branch, and absolute key directory. Each configuration authorizes one repository. There is no default account, automatic installation discovery, or default target repository.

Keep one RSA PEM in a dedicated directory outside every Git repository. Both directory and file must grant access only to the current user, SYSTEM, and Administrators. Checks use SIDs, raw DACLs, every path component, and link metadata; they never repair ACLs. Multiple PEMs, junctions, symbolic links, hardlinks, and broad permissions are rejected. Node reads the key after preflight. Tokens remain in memory and never enter arguments, files, or persistent Git configuration.

Install the App only on intended repositories. The permission ceiling is Contents write, Pull requests write, Metadata read, optional Workflows write and Actions read. Workflows write is requested only when workflow files change. Extra permissions such as Administration, Actions write, Secrets, Checks, or Commit statuses are rejected. Do not give the App bypass access. Each short-lived token must prove access to exactly the configured repository with the exact operation permissions. On completion or failure it is revoked, then the old token must return 401.

## Commands

Replace all placeholders. Configuration, working-directory, and PR body paths are absolute. The wrapper defaults to the repository's pinned Node and never guesses from PATH. CI or separate installations can explicitly supply `-NodeExecutable` with **the same pinned version**.

```powershell
$config = 'C:/work/explorer/config/dev-app.local.json'
$work = 'C:/work/explorer'
./Tools/dev-app-auth.ps1 -ConfigFile $config -Verify
./Tools/dev-app-auth.ps1 -ConfigFile $config -Push -WorkingDirectory $work `
  -Branch codex/my-change -ExpectedHead '<full 40-character commit SHA>'
./Tools/dev-app-auth.ps1 -ConfigFile $config -PullRequest `
  -Branch codex/my-change -ExpectedHead '<full 40-character commit SHA>' `
  -Title 'Describe the resulting change' -BodyFile 'C:/work/explorer/.cache/pr-body.md'
./Tools/dev-app-auth.ps1 -ConfigFile $config -Status `
  -PrNumber 123 -ExpectedHead '<full 40-character commit SHA>'
```

Push accepts only an explicit current `codex/` branch and exact commit in a clean working directory, with origin matching configuration. Git configuration, hooks, helpers, authentication, and environment injections are isolated. Only a single non-force branch push is allowed. PRs must target the configured base and exact head and be authored by the verified App bot. `-PrNumber` can update that bot's matching PR title and body; changing base or another author's PR is rejected. There are no approve, merge, auto-merge, or repository-protection commands.

Refresh local `origin/<base>` before pushing. It must exist, be an ancestor of the task head, and match the live GitHub base SHA; otherwise the push stops. Workflow permissions use the complete base-to-head commit history, including reverted workflow changes. Workflows already on the base do not expand token permissions. A public base can be fetched read-only with credential helpers disabled. Private repositories need a separately authorized App read workflow to prepare local objects; personal credentials must never supply a push fallback.

Any preflight, authentication, scope, push, PR, or revocation failure must stop. **Never fall back to a personal account, Git Credential Manager, `gh auth`, a GitHub connector, or `GH_TOKEN` / `GITHUB_TOKEN`.** Downloading a PEM does not configure ordinary Git to use the App: invoke this entry point. Results omit credentials; keep real local configuration and receipts out of commits. Preflight operates within the current-user trust boundary, rather than proving security against malicious processes running as that same user.

## Human review and additional maintainers

Protect main with required PRs, at least one approval, Code Owner review, approval by someone other than the last pusher, passing CI, resolved discussions, and prohibited force pushes and deletion. The App has no administration or bypass permissions. An explicitly authorized owner protection change is a separate administrative action, never a development credential fallback.

The default [CODEOWNERS](../../.github/CODEOWNERS) assigns every file to a human maintainer. Grant new maintainers explicit repository write access, then add their accounts or an organization team on the same ownership line. Do not list the App as an owner. A sole human can review and merge a bot-authored PR. The final push before approval should also come from the bot; a human push or branch update may require a different eligible reviewer.

The PR that first restores CODEOWNERS uses a base without that file, so its new ownership entries cannot automatically apply to that PR. One required approval, last-push review, and CI still apply; the maintainer reviews it manually. CODEOWNERS governs subsequent PRs after merging. See [GitHub's base-branch rules](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

## Regression checks

Protocol and narrow-token tests use a simulated GitHub API. Real Git isolation, Windows ACL, link, CLI, and no-fallback tests run in Windows integration CI. Fixtures contain generated test keys or opaque placeholders, need no production PEM, and never push a real repository. See [layered CI](CI.md).
