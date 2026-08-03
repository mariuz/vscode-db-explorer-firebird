# Vendored dependencies

One file lives here, and it is here for one reason: an upstream fix this extension asked for is
merged but not published.

## `node-firebird-driver-3.6.0-git.e05c619.tgz`

`node-firebird-driver` built from [asfernandes/node-firebird-drivers][repo] at commit
[`e05c619`][commit] — *"feat(driver): add `ConnectOptions.searchPath` for Firebird 6 SQL schemas
(#173)"*, which closed [issue #172][issue], filed from this repository.

**Why it is vendored.** npm's newest `node-firebird-driver` is 3.6.0, published 4 May 2026;
`searchPath` landed on `master` on 3 August 2026 and has no release yet. npm cannot install a
package from a subdirectory of a git repository, and this is a workspaces monorepo whose packages
use yarn's `workspace:` protocol — so `github:asfernandes/node-firebird-drivers` is not installable
either. A tarball built from that commit is the one form npm can consume unchanged.

Note what that does *not* buy here: `package-lock.json` is git-ignored in this repository, so the
integrity hash npm records for this tarball is not committed with it. The file in this directory is
the artifact itself, and its provenance is the commit named above plus the build recipe below —
which is why both are written down rather than left to `npm ls`.

**What it changes.** Three things, all in `createDpb()` and the `ConnectOptions` interface: the
`isc_dpb_search_path` constant (tag 105), the encoding of a `string | string[]` search path into the
database parameter block, and a 255-character limit. Nothing else in the package differs from
`master`.

**Why the *native* package is not also vendored.** It does not need to be.
`node-firebird-driver-native`'s own `fb-util` re-exports `node-firebird-driver/dist/lib/impl`, so
`createDpb()` — and therefore the DPB the attach sends — comes from this package. The `overrides`
entry in `package.json` points its `^3.6.0` dependency at this same tarball, so one copy is
installed and both packages use it.

**How it was built**, reproducibly:

```bash
git clone https://github.com/asfernandes/node-firebird-drivers.git
cd node-firebird-drivers && git checkout e05c619
# The monorepo's own `npm install` fails on yarn `workspace:` specifiers, and is not needed:
# packages/node-firebird-driver has no runtime dependency beyond @types/node.
cd packages/node-firebird-driver
tsc -p tsconfig.json      # extends ../../tsconfig.base.json
npm pack
```

The tarball's contents are what `npm pack` produced, with the package's own `src/test/` left out —
those files import `vitest`/`fs-extra-promise`, which are not dependencies of the library and are
not reachable from `main`. Everything under `dist/lib` is unmodified compiler output.

**When to remove it.** As soon as upstream publishes a release containing `e05c619` (3.7.0 or
later). Removing it is three edits and no code change: drop the `overrides` block, restore
`"node-firebird-driver": "^3.7.0"` in `dependencies`, and delete this directory.
`NativeClient.createConnection()` in `src/shared/driver.ts` already passes `searchPath` through
`ConnectOptions` and needs nothing.

[repo]: https://github.com/asfernandes/node-firebird-drivers
[commit]: https://github.com/asfernandes/node-firebird-drivers/commit/e05c619394ebc7b01fa4f99aa35230d85a83aa02
[issue]: https://github.com/asfernandes/node-firebird-drivers/issues/172
