# Contributing

## Local checks

Run `npm ci`, `npm test` and `npm run typecheck`. On Node 26, use `NODE_OPTIONS=--no-experimental-webstorage npm test` to avoid a global Web Storage conflict with jsdom.

## Releases

Open a PR that bumps the version in `package.json` and `package-lock.json` and adds a dated entry in `CHANGELOG.md`. When it merges to `main`, the **Tag release** workflow creates `vX.Y.Z` on the commit that landed. An unchanged version does not create a tag, and the workflow never moves an existing tag. The Git tag is the release; there is no npm publish or GitHub Release.
