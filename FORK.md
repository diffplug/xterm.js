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
- `addons/addon-webgl/src/SdfGlyphRasterizer.ts` — new file: vendored
  adaptation of mapbox/tiny-sdf (BSD-2-Clause, attribution in header).
- `addons/addon-webgl/src/{TextureAtlas,GlyphRenderer,WebglAddon,WebglRenderer,CharAtlasUtils,CharAtlasCache,Types}.ts`
  — SDF glyph rendering behind the `sdf` / `sdfGlyphSize` addon options
  (documented in the typings). Eligible glyphs are stored as distance fields
  (alpha channel) at a fixed base size (default 32px, never derived from the
  terminal font) and tinted/reconstructed in the glyph shader. The atlas has
  no notion of color for SDF glyphs — one texture entry per shape, per-color
  records share it — and each texel holds one plain distance field (no
  channel packing) so the layout stays compatible with a future MSDF switch.
  Decorated cells (underline/strike/overline), custom glyphs, powerline
  glyphs and probable emoji keep the raster path. Instance layout is 16
  floats/cell (upstream 11) — merge carefully if upstream touches
  GlyphRenderer vertex code.
- `addons/addon-webgl/src/CharAtlasUtils.test.ts` — config fixture gains the
  `sdf`/`sdfGlyphSize` fields.
- `addons/addon-webgl/typings/addon-webgl.d.ts` — the `declare module` name is
  the published package name (TypeScript only attaches the types to imports if
  they match; an additive re-export block does not work because the file is a
  module, so `export * from '@xterm/addon-webgl'` resolves against
  node_modules and finds nothing).
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
