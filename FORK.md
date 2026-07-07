# diffplug/xterm.js fork

This fork exists to develop **`@diffplug/xterm-addon-webgl-sdf`** — a variant of
`addons/addon-webgl` whose glyph texture atlas uses signed distance fields
(SDF), so terminal text stays crisp at arbitrary scale/orientation (WebXR).
It is consumed by [dormouse](https://github.com/diffplug/dormouse)'s `canopy`
package.

## Branch strategy

- **`master`** — pristine mirror of `xtermjs/xterm.js` master. Fast-forward
  only; never commit here. Sync with `gh repo sync diffplug/xterm.js` or
  `git fetch upstream && git push origin upstream/master:master`.
- **`sdf`** — master + our changes. Merge `master` into `sdf` regularly.
  Divergence is kept additive where possible (new files / appended blocks)
  to minimize merge conflicts.
- Upstreamable fixes branch off `master`, get PR'd to upstream, and are
  cherry-picked into `sdf`.

## What diverges from upstream (keep this list current)

- `addons/addon-webgl/package.json` — package renamed to
  `@diffplug/xterm-addon-webgl-sdf`; version scheme below.
- `addons/addon-webgl/typings/addon-webgl.d.ts` — appended a
  `declare module '@diffplug/xterm-addon-webgl-sdf'` re-export block.
- `FORK.md` (this file).

## Versioning

`<upstream-addon-version>-sdf<upstream-beta>.<iteration>`, e.g.
`0.20.0-sdf288.0` = addon 0.20.0 line, built from the commit of
`@xterm/xterm@6.1.0-beta.288`, our iteration 0. The addon bundles core
internals, so consumers must pin the exact matching `@xterm/xterm` version.

Find the commit for an upstream beta with:
`npm view @xterm/xterm@6.1.0-beta.NNN gitHead`
and base/merge the `sdf` branch on exactly that commit before releasing.

## Building + releasing

```sh
npm install
npm run package                                  # tsc all + esbuild .mjs bundles
(cd addons/addon-webgl && npm run package)       # webpack UMD bundle
(cd addons/addon-webgl && npm pack)              # produces the release tarball
gh release create sdf-vX.Y.Z-sdfNNN.M \
  --repo diffplug/xterm.js --prerelease \
  --title "addon-webgl-sdf X.Y.Z-sdfNNN.M" \
  addons/addon-webgl/diffplug-xterm-addon-webgl-sdf-X.Y.Z-sdfNNN.M.tgz
```

Consumers depend on the release asset by URL (pnpm tarball dependency); the
lockfile records an integrity hash. Treat published release assets as
immutable — cut a new iteration instead of replacing one.
