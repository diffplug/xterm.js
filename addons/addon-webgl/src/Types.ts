/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { FontWeight } from '@xterm/xterm';
import { IColorSet } from 'browser/Types';
import { ISelectionRenderModel } from 'browser/renderer/shared/Types';
import { CursorInactiveStyle, CursorStyle, type IDisposable } from 'common/Types';
import type { IEvent } from 'common/Event';

export interface IRenderModel {
  cells: Uint32Array;
  lineLengths: Uint32Array;
  selection: ISelectionRenderModel;
  cursor?: ICursorRenderModel;
}

export interface ICursorRenderModel {
  x: number;
  y: number;
  width: number;
  style: CursorStyle | CursorInactiveStyle;
  cursorWidth: number;
  dpr: number;
}

export interface IWebGL2RenderingContext extends WebGLRenderingContext {
  vertexAttribDivisor(index: number, divisor: number): void;
  createVertexArray(): IWebGLVertexArrayObject;
  deleteVertexArray(vao: IWebGLVertexArrayObject): void;
  bindVertexArray(vao: IWebGLVertexArrayObject): void;
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instanceCount: number): void;
}

export interface IWebGLVertexArrayObject {
}

export interface ICharAtlasConfig {
  customGlyphs: boolean;
  /** Whether to store eligible glyphs as signed distance fields and tint them in the shader. */
  sdf: boolean;
  /**
   * Base font size in pixels that SDF glyphs are rasterized at, independent of the terminal's
   * font size and devicePixelRatio.
   */
  sdfGlyphSize: number;
  devicePixelRatio: number;
  deviceMaxTextureSize: number;
  letterSpacing: number;
  lineHeight: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: FontWeight;
  fontWeightBold: FontWeight;
  deviceCellWidth: number;
  deviceCellHeight: number;
  deviceCharWidth: number;
  deviceCharHeight: number;
  allowTransparency: boolean;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  colors: IColorSet;
}

export interface ITextureAtlas extends IDisposable {
  readonly pages: { canvas: HTMLCanvasElement, version: number }[];

  onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>;
  onRemoveTextureAtlasCanvas: IEvent<HTMLCanvasElement>;

  /**
   * Warm up the texture atlas, adding common glyphs to avoid slowing early frame.
   */
  warmUp(): void;

  /**
   * Incremented whenever cached glyph texture page mappings may be stale, such as after atlas page
   * merges or overflow page creation. Renderers compare this against their own last-seen value and
   * rebuild their model when it changes; a shared atlas can have many renderers, so this must not
   * be a consume-once flag.
   */
  readonly pageLayoutVersion: number;

  /**
   * Clear all glyphs from the texture atlas.
   */
  clearTexture(): void;
  getRasterizedGlyph(code: number, bg: number, fg: number, ext: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph;
  getRasterizedGlyphCombinedChar(chars: string, bg: number, fg: number, ext: number, restrictToCellHeight: boolean, domContainer: HTMLElement | undefined): IRasterizedGlyph;
}

/**
 * Represents a rasterized glyph within a texture atlas. Some numbers are
 * tracked in CSS pixels as well in order to reduce calculations during the
 * render loop.
 */
export interface IRasterizedGlyph {
  /**
   * The x and y offset between the glyph's top/left and the top/left of a cell
   * in pixels.
   */
  offset: IVector;
  /**
   * The index of the texture page that the glyph is on.
   */
  texturePage: number;
  /**
   * the x and y position of the glyph in the texture in pixels.
   */
  texturePosition: IVector;
  /**
   * the x and y position of the glyph in the texture in clip space coordinates.
   */
  texturePositionClipSpace: IVector;
  /**
   * The width and height of the glyph in the texture in pixels.
   */
  size: IVector;
  /**
   * The width and height of the glyph in the texture in clip space coordinates.
   */
  sizeClipSpace: IVector;
  /**
   * Whether the texture data is a signed distance field (alpha channel = distance, tint applied
   * in the shader) rather than a direct color raster.
   */
  sdf: boolean;
  /**
   * Factor to scale the texture rect by when rendering (render px = size * renderScale). Always 1
   * for raster glyphs; for SDF glyphs this maps the SDF base size to the terminal's device font
   * size.
   */
  renderScale: number;
  /** Straight-alpha tint applied in the shader for SDF glyphs, as normalized [0-1] channels. */
  tintR: number;
  tintG: number;
  tintB: number;
  tintA: number;
}

export interface IVector {
  x: number;
  y: number;
}

export interface IBoundingBox {
  top: number;
  left: number;
  right: number;
  bottom: number;
}
