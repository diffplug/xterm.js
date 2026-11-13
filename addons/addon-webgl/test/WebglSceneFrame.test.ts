/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import test, { expect } from '@playwright/test';
import { createTestContext, openTerminal } from '../../../test/playwright/TestUtils';
import { platform } from 'os';

// Fork (scene frame): `onSceneFrame` hands a caller what each WebGL frame drew, so it can draw the
// same terminal in another context. The hazard is the frame drifting from what was drawn: the
// glyph view must be this frame's slice of the double buffer, laid out as `glyphLayout` says.
test.describe('WebGL scene frame', () => {
  if (platform() === 'linux') {
    test.skip(({ browserName }) => browserName === 'firefox' || browserName === 'webkit');
  }

  for (const sdf of [false, true]) {
    test(`sdf=${sdf}: each frame carries the drawn glyphs, backgrounds, and atlas pages`, async ({ browser }) => {
      const ctx = await createTestContext(browser);
      try {
        await openTerminal(ctx);
        const result = await ctx.page.evaluate(async sdf => {
          const w = window as any;
          const el = document.createElement('div');
          document.body.appendChild(el);
          const term = new w.Terminal({ cols: 20, rows: 4, allowProposedApi: true });
          term.open(el);
          const addon = new w.WebglAddon({ sdf });
          term.loadAddon(addon);
          if (!addon._renderer) {
            return undefined;
          }
          const frames: any[] = [];
          const sub = addon.onSceneFrame((f: any) => frames.push({
            glyphs: Array.from(f.glyphs as Float32Array),
            stride: f.glyphStride,
            layout: f.glyphLayout,
            backgrounds: f.backgrounds.length / f.rectStride,
            pages: f.pages.length,
            resolution: f.resolution,
            sameAsGetter: addon.sceneFrame === f
          }));
          await new Promise<void>(r => term.write('\x1b[2;3Hab', r));
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          sub.dispose();
          term.dispose();
          el.remove();
          return { frames, cols: term.cols, rows: term.rows };
        }, sdf);

        test.skip(!result, 'WebGL2 renderer not available in this browser');
        const frame = result!.frames.at(-1);
        expect(frame, 'a write must produce a scene frame').toBeDefined();
        expect(frame.sameAsGetter).toBe(true);
        expect(frame.pages).toBeGreaterThan(0);
        expect(frame.backgrounds, 'the viewport clear rect at least').toBeGreaterThan(0);
        expect(frame.glyphs.length % frame.stride).toBe(0);
        // 'a' and 'b' sit at columns 2 and 3 of row 1; cellpos is in terminal space.
        const cells: [number, number][] = [];
        for (let i = 0; i < frame.glyphs.length; i += frame.stride) {
          const sizeX = frame.glyphs[i + frame.layout.size];
          if (sizeX > 0) {
            cells.push([
              Math.round(frame.glyphs[i + frame.layout.cellpos] * result!.cols),
              Math.round(frame.glyphs[i + frame.layout.cellpos + 1] * result!.rows)
            ]);
          }
        }
        expect(cells).toEqual([[2, 1], [3, 1]]);
        if (sdf) {
          for (let i = 0; i < frame.glyphs.length; i += frame.stride) {
            if (frame.glyphs[i + frame.layout.size] > 0) {
              expect(frame.glyphs[i + frame.layout.sdf], 'plain letters take the SDF path').toBeGreaterThan(0.5);
            }
          }
        }
      } finally {
        await ctx.page.close();
      }
    });
  }
});
