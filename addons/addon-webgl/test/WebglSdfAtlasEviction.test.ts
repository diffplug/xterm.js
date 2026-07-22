/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Fork addition. Upstream's WebglAtlasOverflow covers atlas eviction on the raster path; the SDF
 * path keeps a third cache of IRasterizedGlyph records (_sdfGlyphCache, keyed by shape rather than
 * shape+color) whose entries carry texturePage indices. Any cache of rasterized glyphs has to be
 * dropped when pages are destroyed, so this exercises the SDF path across an eviction.
 */

import test, { expect } from '@playwright/test';
import type { Terminal, ITerminalInitOnlyOptions, ITerminalOptions } from '@xterm/xterm';
import type { IWebglAddonOptions, WebglAddon } from '@diffplug/xterm-addon-webgl-sdf';
import { ITestContext, createTestContext, openTerminal } from '../../../test/playwright/TestUtils';

type TestTerminalConstructor = new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => ITestTerminal;
type TestWebglAddonConstructor = new (options?: IWebglAddonOptions) => ITestWebglAddon;

interface ITestTextureAtlasConstructor {
  maxAtlasPages: number | undefined;
  maxTextureSize: number | undefined;
}

interface ITestTextureAtlas {
  constructor: ITestTextureAtlasConstructor;
  pages: unknown[];
  pageLayoutVersion: number;
  _sdfGlyphCache: Map<string, { texturePage: number }>;
}

interface ITestRenderer {
  _charAtlas?: ITestTextureAtlas;
}

interface ITestTerminal extends Terminal {
  _core?: {
    _renderService?: {
      _renderer?: { value?: ITestRenderer };
    };
  };
}

interface ITestWebglAddon extends WebglAddon {
  _renderer?: ITestRenderer;
}

interface ITestWindow extends Window {
  Terminal: TestTerminalConstructor;
  WebglAddon: TestWebglAddonConstructor;
  term: ITestTerminal;
  addon?: ITestWebglAddon;
  atlasRemovals?: number;
}

interface IAtlasLimits {
  maxAtlasPages: number;
  maxTextureSize: number;
}

interface ISdfAtlasState {
  pages: number;
  pageLayoutVersion: number;
  sdfCacheSize: number;
  /**
   * Cached SDF records whose texturePage is past the end of the page array. The flood repopulates
   * the cache immediately after an eviction, so cache size alone says nothing; what must always
   * hold is that no surviving record points at a page that no longer exists.
   */
  staleSdfRecords: number;
  removals: number;
}

/** Text drawn before the eviction, then again after it in a second colour. */
const SHARED_SHAPES = '丁丂七丄丅 SDF_REF_0123456789';

async function loadSdfAddon(ctx: ITestContext): Promise<void> {
  await ctx.page.evaluate(() => {
    const w = window as unknown as ITestWindow;
    w.addon = new w.WebglAddon({ preserveDrawingBuffer: true, sdf: true, sdfGlyphSize: 32 });
    w.term.loadAddon(w.addon);
  });
  const isWebglRenderer = await ctx.page.evaluate(() => {
    const w = window as unknown as ITestWindow;
    return !!w.addon && w.term._core?._renderService?._renderer?.value === w.addon._renderer;
  });
  expect(isWebglRenderer, 'the SDF WebGL renderer must be active').toBe(true);
}

async function configureAtlasLimits(ctx: ITestContext): Promise<IAtlasLimits | undefined> {
  const limits = await ctx.page.evaluate(() => {
    const w = window as unknown as ITestWindow;
    const atlas = w.term._core?._renderService?._renderer?.value?._charAtlas;
    if (!atlas || atlas.constructor.maxAtlasPages === undefined || atlas.constructor.maxTextureSize === undefined) {
      return undefined;
    }
    const original = {
      maxAtlasPages: atlas.constructor.maxAtlasPages,
      maxTextureSize: atlas.constructor.maxTextureSize
    };
    atlas.constructor.maxAtlasPages = 4;
    atlas.constructor.maxTextureSize = 512;
    return original;
  });
  expect(limits, 'TextureAtlas limits must be initialized').toBeDefined();
  return limits;
}

async function restoreAtlasLimits(ctx: ITestContext, limits: IAtlasLimits | undefined): Promise<void> {
  if (!limits) {
    return;
  }
  await ctx.page.evaluate(original => {
    const w = window as unknown as ITestWindow;
    const atlas = w.term._core?._renderService?._renderer?.value?._charAtlas;
    if (atlas) {
      atlas.constructor.maxAtlasPages = original.maxAtlasPages;
      atlas.constructor.maxTextureSize = original.maxTextureSize;
    }
  }, limits);
}

async function trackRemovals(ctx: ITestContext): Promise<void> {
  const installed = await ctx.page.evaluate(() => {
    const w = window as unknown as ITestWindow;
    if (!w.addon) {
      return false;
    }
    w.atlasRemovals = 0;
    w.addon.onRemoveTextureAtlasCanvas(() => { w.atlasRemovals = (w.atlasRemovals ?? 0) + 1; });
    return true;
  });
  expect(installed, 'atlas removal tracking must be installed').toBe(true);
}

async function getSdfAtlasState(ctx: ITestContext): Promise<ISdfAtlasState> {
  const state = await ctx.page.evaluate(() => {
    const w = window as unknown as ITestWindow;
    const atlas = w.term._core?._renderService?._renderer?.value?._charAtlas;
    if (!atlas) {
      return undefined;
    }
    let stale = 0;
    for (const glyph of atlas._sdfGlyphCache.values()) {
      if (glyph.texturePage >= atlas.pages.length) {
        stale++;
      }
    }
    return {
      pages: atlas.pages.length,
      pageLayoutVersion: atlas.pageLayoutVersion,
      sdfCacheSize: atlas._sdfGlyphCache.size,
      staleSdfRecords: stale,
      removals: w.atlasRemovals ?? 0
    };
  });
  expect(state, 'the SDF atlas must be reachable').toBeDefined();
  return state!;
}

async function writeAndWaitForRender(ctx: ITestContext, data: string): Promise<void> {
  const renderPromise = new Promise<void>(resolve => {
    const disposable = ctx.proxy.onRender(() => {
      disposable.dispose();
      resolve();
    });
  });
  await ctx.proxy.write(data);
  await renderPromise;
}

function generateUniqueGlyphFlood(count: number, cols: number, offset: number): string {
  const base = 0x4E00;
  const range = 0x9FFF - base;
  const perRow = Math.max(1, Math.floor(cols / 2));
  let result = '';
  for (let i = 0; i < count; i++) {
    result += String.fromCodePoint(base + ((offset + i) % range));
    if ((i + 1) % perRow === 0 && i + 1 < count) {
      result += '\r\n';
    }
  }
  return result;
}

test.describe('SDF atlas eviction', () => {
  test.skip(({ browserName }) => browserName !== 'chromium');
  test.describe.configure({ timeout: 90000 });

  test('re-renders cached SDF shapes after the atlas evicts its pages', async ({ browser }) => {
    const ctx = await createTestContext(browser);
    const errors: string[] = [];
    const onError = (error: Error): void => { errors.push(error.message); };
    let limits: IAtlasLimits | undefined;
    ctx.page.on('pageerror', onError);
    try {
      await openTerminal(ctx, { cols: 80, rows: 24 });
      await loadSdfAddon(ctx);
      limits = await configureAtlasLimits(ctx);

      await openTerminal(ctx, { cols: 80, rows: 24 });
      await loadSdfAddon(ctx);
      await trackRemovals(ctx);

      // Populate _sdfGlyphCache with shapes that are re-requested after the eviction below.
      await writeAndWaitForRender(ctx, `\x1b[H\x1b[38;5;39m${SHARED_SHAPES}\x1b[0m`);
      const seeded = await getSdfAtlasState(ctx);
      expect(seeded.sdfCacheSize, 'SDF shapes must be cached before eviction').toBeGreaterThan(0);

      // Flood unique glyphs until the page cap forces an eviction.
      const glyphsPerChunk = 23 * 40 - 1;
      for (let chunk = 0; chunk < 24; chunk++) {
        await ctx.proxy.write('\x1b[H\x1b[2J' + generateUniqueGlyphFlood(glyphsPerChunk, 80, chunk * glyphsPerChunk));
        await ctx.page.waitForTimeout(50);
        const state = await getSdfAtlasState(ctx);
        if (state.removals > 0 || errors.length > 0) {
          break;
        }
      }

      const evicted = await getSdfAtlasState(ctx);
      expect(evicted.removals, 'the atlas must evict pages at the page cap').toBeGreaterThan(0);
      expect(evicted.pageLayoutVersion, 'eviction must invalidate renderer models').toBeGreaterThan(seeded.pageLayoutVersion);
      expect(evicted.staleSdfRecords, 'eviction must drop cached SDF records along with their pages').toBe(0);

      // Re-request the seeded shapes in a different colour. This is the alias path: a cache hit
      // resolves the shape's canonical record and registers a colour variant on its page, so a
      // record left over from a destroyed page indexes past the end of the page array.
      await writeAndWaitForRender(ctx, `\x1b[H\x1b[2J\x1b[38;5;208m${SHARED_SHAPES}\x1b[0m`);
      expect(errors, `the SDF renderer must not throw across an eviction: ${errors[0] ?? ''}`).toEqual([]);

      const rerendered = await getSdfAtlasState(ctx);
      expect(rerendered.sdfCacheSize, 'the shapes must be re-rasterized onto the new pages').toBeGreaterThan(0);
      expect(rerendered.staleSdfRecords, 'no cached SDF record may outlive the page it was drawn to').toBe(0);
      expect(rerendered.pages, 'the atlas must stay within the page cap after re-rendering').toBeLessThanOrEqual(4);
    } finally {
      ctx.page.off('pageerror', onError);
      await restoreAtlasLimits(ctx, limits).catch(() => {});
      await ctx.page.close();
    }
  });
});
