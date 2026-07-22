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

## Merging upstream

Triggered whenever dormouse sees an `@xterm/*` bump (Renovate groups them into
one `xterm` PR). Do not merge that PR and leave the fork behind: the point of
the fork is that `canopy` compares upstream against us, and a stale base makes
the comparison meaningless. The dormouse-side counterpart of this process is
in `docs/specs/webgl-text.md`.

1. **Read the diff before merging it.** `gh api repos/xtermjs/xterm.js/compare/<oldGitHead>...<newGitHead>`.
   Derive the git heads with `npm view @xterm/xterm@6.1.0-beta.NNN gitHead`.
   Most betas do not touch `addons/addon-webgl` at all — when none of the
   changed files are ours, the merge is mechanical. Note which upstream
   fixes are real improvements for us, since that is what justifies the work.
2. **A clean merge is not a correct merge.** Our divergence is deliberately
   additive, so git rarely produces a conflict. What it cannot see is upstream
   *adding a new obligation* to code we extended — a new lifecycle hook, a new
   place an invariant must be re-established, a new interface member. TypeScript
   will not catch these either. For every upstream function that touches atlas
   pages, glyph caches, or the renderer model, ask what fork-added state it
   should also be handling. `_evictAllPages` (upstream #6043) had to learn about
   `_sdfGlyphCache`; nothing flagged that.
3. **Run the integration suite, not just `tsc`.**
   `npx playwright test -c addons/addon-webgl/test/playwright.config.ts --project=Chromium`
   after `npm run esbuild && npm run esbuild-demo-client` — the demo client
   bundle is what the browser loads, so a source edit without both build steps
   silently tests the old code. Upstream's atlas tests run against us with
   `sdf: false` and are the best available check that the fork left upstream
   behavior alone.
4. **Cover new fork-side hazards with a test**, next to the upstream test that
   covers the raster equivalent. Prove it fails without the fix.
5. **Release and bump `canopy`** per the sections below; the pins and the
   tarball URL move together.

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
- `addons/addon-webgl/test/WebglSdfAtlasEviction.test.ts` — new file: drives
  the SDF path across an atlas page eviction. The invariant it guards is that
  no cached SDF record outlives the page it was drawn to.
- `addons/addon-webgl/test/Webgl*.test.ts` (upstream files) — the addon type
  import is rewritten from `@xterm/addon-webgl` to the published fork name.
  Any new upstream addon test needs the same rewrite when it arrives in a
  merge; without it the module does not resolve and `npm run tsc` fails.
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
