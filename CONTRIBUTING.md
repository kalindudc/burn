# Contributing to Burn

Bug reports, focused fixes, and documentation improvements are welcome. Start with an issue, then link it in your pull request. A good report helps even if you don’t have a fix.

## Start with an issue

Search [open and closed issues](https://github.com/kalindudc/burn/issues?q=is%3Aissue) and [pull requests](https://github.com/kalindudc/burn/pulls?q=is%3Apr) before opening a new one. If there’s already an issue, use it and add only information that helps reproduce the problem or decide what to do.

- **Bug reports:** Say what you expected, what happened, and how to reproduce it. Include the Burn version or commit, whether you use Burn in bb or Pi, and the relevant harness, versions, and operating system. Share a small, redacted example, not full session logs, credentials, or private prompts.
- **Feature requests:** Explain the problem, who it affects, and what you do today. For a new integration, user experience change, or broad refactor, discussing the approach first can save rework.
- **Security vulnerabilities:** [Report them privately](https://github.com/kalindudc/burn/security/advisories/new), not in a public issue or PR.

## Open a focused pull request

You don’t need maintainer approval before opening a PR, but every PR must link to an issue. Open it against `main` from a branch in your fork. Use `Fixes #123` if the change fully resolves the issue, or `Related to #123` if it only addresses part of it.

- Keep the PR focused on one change. Follow existing code and test conventions, and leave unrelated cleanup and dependency updates out.
- Explain the behavior before and after your change and what you verified. Report failures, skipped checks, and known limits. Include before-and-after screenshots for visible UI changes.
- Add a regression test for a bug fix and tests for new behavior. For usage readers, use a small synthetic or redacted fixture and identify the harness and version. For model pricing, link the provider’s published rates and test any tier boundaries.
- Update the relevant docs when behavior changes. User-visible changes can be noted under `Unreleased` in [CHANGELOG.md](CHANGELOG.md). Leave release versions, dated release entries, and tags to the repository owner.

## Use AI, then review the work yourself

We encourage using AI to explore the code, write changes and tests, and challenge your approach. Before opening a PR, personally review the entire diff, including the tests and docs. Run the relevant checks yourself, inspect the results, and make sure you can explain what changed, why, and what remains unverified. An AI review can help, but it doesn’t replace your own. Disclose material AI assistance in the PR and say what you used it for.

Unverified claims, fabricated test results, unrelated rewrites, and generated changes the submitter can’t explain will be rejected. The maintainer may close low-effort submissions without a line-by-line review.

## Local checks

Run `npm ci`, `npm test`, and `npm run typecheck`. The Checks workflow runs the last two on every pull request, and on every push to `main` before a release is tagged. For changes to the bb plugin, also run `bb plugin build`, which CI does not. On Node 26, use `NODE_OPTIONS=--no-experimental-webstorage npm test` to avoid a Web Storage conflict with jsdom. Include the actual results in the PR.
