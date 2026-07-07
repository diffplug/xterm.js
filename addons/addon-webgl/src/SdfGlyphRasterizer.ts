/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * This file is an adaptation of mapbox/tiny-sdf (https://github.com/mapbox/tiny-sdf),
 * Copyright (c) 2016-2024 Mapbox, Inc. (BSD-2-Clause):
 *
 *   Redistribution and use in source and binary forms, with or without modification, are permitted
 *   provided that the following conditions are met:
 *   1. Redistributions of source code must retain the above copyright notice, this list of
 *      conditions and the following disclaimer.
 *   2. Redistributions in binary form must reproduce the above copyright notice, this list of
 *      conditions and the following disclaimer in the documentation and/or other materials
 *      provided with the distribution.
 *   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
 *   IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 *   AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 *   CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 *   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 *   SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 *   THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 *   OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *   POSSIBILITY OF SUCH DAMAGE.
 *
 * Adaptations for the terminal glyph atlas:
 * - Text is measured and drawn with xterm's TEXT_BASELINE so metrics line up with the cell
 *   baseline used by the raster path in TextureAtlas.
 * - The scratch canvas grows dynamically so wide (CJK) and combined-character strings fit.
 * - Font weight/style are set per draw call (bold/italic glyph variants share one rasterizer).
 * - The result carries the bitmap's position relative to the cell origin so the atlas can
 *   compute render offsets in device pixels.
 */

import { TEXT_BASELINE } from './Constants';

const INF = 1e20;

/**
 * How much of the SDF byte range represents inside vs outside the edge. The glyph shader must
 * use `1 - SDF_CUTOFF` as its edge threshold when reconstructing coverage from the atlas.
 */
export const SDF_CUTOFF = 0.25;

/**
 * Default base font size in pixels for SDF rasterization when the addon option is not set. A
 * fixed constant, deliberately not derived from the terminal's font size or devicePixelRatio.
 */
export const DEFAULT_SDF_GLYPH_SIZE = 32;

// Lookup table for gamma-corrected, signed squared alpha distance values
const alphaTable = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const d = 0.5 - Math.pow(i / 255, 1 / 2.2);
  alphaTable[i] = d * Math.abs(d);
}
alphaTable[255] = -INF;

export interface ISdfGlyph {
  /** Single-channel SDF bitmap, row-major, `width * height` bytes. 0 = far outside the glyph. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Position of the bitmap's top-left corner relative to the cell origin, in SDF-space pixels
   * (negative values mean the bitmap extends above/left of the cell).
   */
  left: number;
  top: number;
}

const EMPTY_GLYPH: ISdfGlyph = { data: new Uint8ClampedArray(0), width: 0, height: 0, left: 0, top: 0 };

export class SdfGlyphRasterizer {
  /** Distance falloff radius in SDF-space pixels. */
  public readonly radius: number;
  /**
   * Padding around the glyph ink box. Sized so the SDF decays to 0 before the bitmap border,
   * which guarantees LINEAR atlas sampling never bleeds into neighboring glyphs.
   */
  public readonly buffer: number;

  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  private _gridOuter!: Float64Array;
  private _gridInner!: Float64Array;
  private _f!: Float64Array;
  private _z!: Float64Array;
  private _v!: Uint16Array;

  constructor(
    document: Document,
    private readonly _fontSize: number,
    private readonly _fontFamily: string
  ) {
    this.radius = Math.max(2, this._fontSize / 3);
    this.buffer = Math.ceil(this.radius * (1 - SDF_CUTOFF)) + 1;
    this._canvas = document.createElement('canvas');
    this._canvas.width = this._canvas.height = Math.ceil(this._fontSize + this.buffer * 4);
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true })!;
    this._allocGrids();
  }

  private _allocGrids(): void {
    const size = Math.max(this._canvas.width, this._canvas.height);
    this._gridOuter = new Float64Array(this._canvas.width * this._canvas.height);
    this._gridInner = new Float64Array(this._canvas.width * this._canvas.height);
    this._f = new Float64Array(size);
    this._z = new Float64Array(size + 1);
    this._v = new Uint16Array(size);
  }

  private _ensureCanvasSize(width: number, height: number): void {
    if (this._canvas.width >= width && this._canvas.height >= height) {
      return;
    }
    this._canvas.width = Math.max(this._canvas.width, width);
    this._canvas.height = Math.max(this._canvas.height, height);
    this._allocGrids();
  }

  /**
   * Rasterize `chars` as a signed distance field.
   * @param fontWeight CSS font weight for this glyph variant.
   * @param fontStyle CSS font style ('' or 'italic').
   * @param charHeight Where the TEXT_BASELINE baseline sits below the cell top, in SDF-space
   * pixels (the SDF-space analog of ICharAtlasConfig.deviceCharHeight).
   * @param maxInkWidth Upper bound on ink width in SDF-space pixels, guarding against giant
   * ligatures blowing up the scratch canvas.
   */
  /**
   * (Re)apply the drawing state. Canvas dimension changes reset all context state, so this must
   * run again after _ensureCanvasSize grows the canvas.
   */
  private _configureContext(fontWeight: string | number, fontStyle: string): void {
    this._ctx.font = `${fontStyle} ${fontWeight} ${this._fontSize}px ${this._fontFamily}`;
    this._ctx.textBaseline = TEXT_BASELINE;
    this._ctx.textAlign = 'left';
    this._ctx.fillStyle = 'black';
  }

  public draw(chars: string, fontWeight: string | number, fontStyle: string, charHeight: number, maxInkWidth: number): ISdfGlyph {
    const ctx = this._ctx;
    this._configureContext(fontWeight, fontStyle);

    const m = ctx.measureText(chars);
    const glyphTop = Math.ceil(m.actualBoundingBoxAscent);
    // actualBoundingBoxLeft is positive when ink extends left of the origin, so negate to get
    // the ink's left edge relative to the draw origin
    const glyphLeft = Math.floor(-m.actualBoundingBoxLeft);
    const glyphWidth = Math.max(0, Math.min(maxInkWidth, Math.ceil(m.actualBoundingBoxRight) - glyphLeft));
    const glyphHeight = Math.max(0, glyphTop + Math.ceil(m.actualBoundingBoxDescent));
    if (glyphWidth === 0 || glyphHeight === 0) {
      return EMPTY_GLYPH;
    }

    const buffer = this.buffer;
    const width = glyphWidth + 2 * buffer;
    const height = glyphHeight + 2 * buffer;
    this._ensureCanvasSize(width, height);
    this._configureContext(fontWeight, fontStyle);

    ctx.clearRect(0, 0, width, height);
    ctx.fillText(chars, buffer - glyphLeft, buffer + glyphTop);
    const imgData = ctx.getImageData(buffer, buffer, glyphWidth, glyphHeight);

    const len = width * height;
    const gridOuter = this._gridOuter;
    const gridInner = this._gridInner;
    gridOuter.fill(INF, 0, len);
    gridInner.fill(0, 0, len);

    let imgIdx = 3; // start at the alpha channel of the first pixel
    for (let y = 0; y < glyphHeight; y++) {
      let j = (y + buffer) * width + buffer;
      for (let x = 0; x < glyphWidth; x++, imgIdx += 4, j++) {
        const a = imgData.data[imgIdx];
        if (a === 0) continue; // empty pixels
        const t = alphaTable[a];
        gridOuter[j] = Math.max(0, t);
        gridInner[j] = Math.max(0, -t);
      }
    }

    edt(gridOuter, 0, 0, width, height, width, this._f, this._v, this._z);
    // Pad the inner EDT region by 1px so ink pixels touching the bbox edge can see the
    // outside-ink seeds in the buffer region
    edt(gridInner, buffer - 1, buffer - 1, glyphWidth + 2, glyphHeight + 2, width, this._f, this._v, this._z);

    const data = new Uint8ClampedArray(len);
    const scale = 255 / this.radius;
    const base = 255 * (1 - SDF_CUTOFF);
    for (let i = 0; i < len; i++) {
      const d = Math.sqrt(gridOuter[i]) - Math.sqrt(gridInner[i]);
      data[i] = Math.round(base - scale * d);
    }

    return {
      data,
      width,
      height,
      left: glyphLeft - buffer,
      top: charHeight - glyphTop - buffer
    };
  }
}

// 2D Euclidean squared distance transform by Felzenszwalb & Huttenlocher
// https://cs.brown.edu/~pff/papers/dt-final.pdf
function edt(data: Float64Array, x0: number, y0: number, width: number, height: number, gridSize: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  for (let x = x0; x < x0 + width; x++) edt1d(data, y0 * gridSize + x, gridSize, height, f, v, z);
  for (let y = y0; y < y0 + height; y++) edt1d(data, y * gridSize + x0, 1, width, f, v, z);
}

// 1D squared distance transform
function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];

  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);

    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}
