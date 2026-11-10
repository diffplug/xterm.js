/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test, { expect } from '@playwright/test';
import type { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@diffplug/xterm-addon-webgl-sdf';
import { ITestContext, createTestContext, openTerminal, pollFor } from '../../../test/playwright/TestUtils';
import { platform } from 'os';

interface ITestGlyph {
  size: { x: number, y: number };
  offset: { x: number, y: number };
  sdf: boolean;
  renderScale: number;
}

interface ITestTextureAtlas {
  getRasterizedGlyph(code: number, ...args: unknown[]): ITestGlyph;
}

interface ITestWebglAddon extends WebglAddon {
  _renderer?: {
    dimensions: { device: { cell: { width: number }, char: { left: number }, canvas: { width: number } } };
    _charAtlas?: ITestTextureAtlas;
    _glyphRenderer: { value?: { _vertices: { attributes: Float32Array } } };
  };
}

interface ITestWindow {
  WebglAddon: new (options: { sdf: boolean }) => ITestWebglAddon;
  term: Terminal;
  addon: ITestWebglAddon;
  fakedGlyphsSdf: boolean[];
}

test.describe('WebGL rescale overlapping glyphs', () => {
  if (platform() === 'linux') {
    test.skip(({ browserName }) => browserName === 'firefox' || browserName === 'webkit');
  }

  // The fork runs both cases over SDF glyphs too: their atlas size is in SDF base pixels, so the
  // rescale threshold must see `size * renderScale` while the offset is already in device pixels
  for (const sdf of [false, true]) {
    test(`sdf=${sdf}: rescaled glyphs are drawn inside their cell`, async ({ browser }) => {
      const ctx = await createTestContext(browser);
      try {
        await openTerminal(ctx, { rescaleOverlappingGlyphs: true });
        const cellWidth = await loadWebglAddon(ctx, { sdf });
        await writeGlyphs(ctx, sdf, {
          [0x2228]: { width: cellWidth + 2, left: Math.floor(cellWidth / 2) },
          [0x222A]: { width: cellWidth * 2, left: -2 }
        });
        await pollFor(ctx.page, () => getGlyphBounds(ctx), [[1, cellWidth], [0, cellWidth - 1]]);
        expect(await getFakedGlyphsSdf(ctx)).toEqual([sdf, sdf]);
      } finally {
        await ctx.page.close();
      }
    });

    test(`sdf=${sdf}: glyphs that end just past half way into the following cell are rescaled`, async ({ browser }) => {
      const ctx = await createTestContext(browser);
      try {
        await openTerminal(ctx, { rescaleOverlappingGlyphs: true });
        const cellWidth = await loadWebglAddon(ctx, { sdf, oddCellWidth: true });
        expect(cellWidth % 2).toBe(1);
        const halfCellWidth = Math.floor(cellWidth / 2);
        await writeGlyphs(ctx, sdf, {
          [0x2228]: { width: cellWidth + 1, left: halfCellWidth - 1 },
          [0x222A]: { width: cellWidth + 1, left: halfCellWidth }
        });
        await pollFor(ctx.page, () => getGlyphBounds(ctx), [[halfCellWidth - 1, cellWidth + halfCellWidth], [1, cellWidth]]);
      } finally {
        await ctx.page.close();
      }
    });
  }
});

async function loadWebglAddon(ctx: ITestContext, options: { sdf: boolean, oddCellWidth?: boolean }): Promise<number> {
  return ctx.page.evaluate(options => {
    const w = window as unknown as ITestWindow;
    w.addon = new w.WebglAddon({ sdf: options.sdf });
    w.term.loadAddon(w.addon);
    const renderer = w.addon._renderer;
    if (!renderer) {
      throw new Error('WebGL renderer must be available');
    }
    if (options.oddCellWidth && renderer.dimensions.device.cell.width % 2 === 0) {
      w.term.options.letterSpacing = 1;
    }
    return renderer.dimensions.device.cell.width;
  }, options);
}

async function writeGlyphs(ctx: ITestContext, sdf: boolean, glyphs: { [code: number]: { width: number, left: number } }): Promise<void> {
  await ctx.page.evaluate(([sdf, glyphs]) => {
    const w = window as unknown as ITestWindow;
    w.fakedGlyphsSdf = [];
    const renderer = w.addon._renderer;
    const atlas = renderer?._charAtlas;
    if (!renderer || !atlas) {
      throw new Error('WebGL renderer and texture atlas must be available');
    }
    // Patch the prototype so the glyphs stay the same if the atlas is recreated, for example after
    // the WebGL context is restored
    const atlasPrototype = Object.getPrototypeOf(atlas) as ITestTextureAtlas;
    const getRasterizedGlyph = atlasPrototype.getRasterizedGlyph;
    atlasPrototype.getRasterizedGlyph = function(code, ...args) {
      const glyph = getRasterizedGlyph.call(this, code, ...args);
      const fake = glyphs[code];
      if (!fake) {
        return glyph;
      }
      w.fakedGlyphsSdf.push(glyph.sdf);
      // `fake.width` is in device pixels; an SDF glyph's atlas size is scaled by renderScale when
      // drawn, while its offset is already in device pixels
      const sizeX = sdf ? fake.width / glyph.renderScale : fake.width;
      return { ...glyph, size: { x: sizeX, y: glyph.size.y }, offset: { x: renderer.dimensions.device.char.left - fake.left, y: glyph.offset.y } };
    };
    w.term.write('a\u2228b\u222Ac');
  }, [sdf, glyphs] as const);
}

async function getFakedGlyphsSdf(ctx: ITestContext): Promise<boolean[]> {
  return ctx.page.evaluate(() => (window as unknown as ITestWindow).fakedGlyphsSdf.slice(0, 2));
}

async function getGlyphBounds(ctx: ITestContext): Promise<number[][] | undefined> {
  return ctx.page.evaluate(() => {
    const indicesPerCell = 16; // fork instance layout (upstream 11)
    const renderer = (window as unknown as ITestWindow).addon._renderer;
    const attributes = renderer?._glyphRenderer.value?._vertices.attributes;
    if (!renderer || !attributes) {
      return undefined;
    }
    return [1, 3].map(x => {
      const left = attributes[x * indicesPerCell];
      return [left, Math.round(left + attributes[x * indicesPerCell + 2] * renderer.dimensions.device.canvas.width)];
    });
  });
}
