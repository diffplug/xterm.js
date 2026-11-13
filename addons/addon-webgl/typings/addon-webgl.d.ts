/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Terminal, ITerminalAddon, IEvent } from '@xterm/xterm';

// Fork (diffplug/xterm.js sdf branch): renamed from '@xterm/addon-webgl' —
// the declared module name must match the published package name for
// TypeScript to attach these types to imports.
declare module '@diffplug/xterm-addon-webgl-sdf' {
  /**
   * An xterm.js addon that provides hardware-accelerated rendering functionality via WebGL.
   */
  export class WebglAddon implements ITerminalAddon {
    public textureAtlas?: HTMLCanvasElement;

    /**
     * An event that is fired when the renderer loses its canvas context.
     */
    public readonly onContextLoss: IEvent<void>;

    /**
     * An event that is fired when the texture atlas of the renderer changes.
     */
    public readonly onChangeTextureAtlas: IEvent<HTMLCanvasElement>;

    /**
     * An event that is fired when a new page is added to the texture atlas.
     */
    public readonly onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>;

    /**
     * An event that is fired when a page is removed from the texture atlas.
     */
    public readonly onRemoveTextureAtlasCanvas: IEvent<HTMLCanvasElement>;

    /**
     * Fork: fires after every frame the renderer draws, with that frame as plain data, so a
     * caller can draw the same terminal into its own WebGL context with its own projection (a
     * WebXR scene) — glyph quads and SDF edges stay crisp at any scale or tilt there, where a
     * texture of the canvas is resampled. The frame's arrays are overwritten by the next frame.
     */
    public readonly onSceneFrame: IEvent<IWebglSceneFrame>;

    /**
     * Fork: the last frame drawn (see `onSceneFrame`), or undefined before the first.
     */
    public readonly sceneFrame: IWebglSceneFrame | undefined;

    constructor(options?: IWebglAddonOptions);

    /**
     * Activates the addon.
     * @param terminal The terminal the addon is being loaded in.
     */
    public activate(terminal: Terminal): void;

    /**
     * Disposes the addon.
     */
    public dispose(): void;

    /**
     * Clears the terminal's texture atlas and triggers a redraw.
     */
    public clearTextureAtlas(): void;
  }

  /**
   * Fork: one frame the renderer drew. Positions are in terminal space: (0, 0) is the canvas's
   * top-left and (1, 1) its bottom-right; a glyph also carries an offset in device px, divided by
   * `resolution`. A glyph quad covers `cellpos + offset / resolution` to that plus `size`, and
   * samples atlas page `texpage` from `texcoord` to `texcoord + texsize`.
   */
  export interface IWebglSceneFrame {
    /** The canvas size in device px. */
    readonly resolution: { readonly width: number, readonly height: number };
    /** Glyph instances, `glyphStride` floats each, with fields at the `glyphLayout` offsets. */
    readonly glyphs: Float32Array;
    readonly glyphStride: number;
    readonly glyphLayout: {
      /** vec2, device px. */
      readonly offset: number;
      /** vec2, terminal space. */
      readonly size: number;
      /** float, index into `pages`. */
      readonly texpage: number;
      /** vec2, atlas uv. */
      readonly texcoord: number;
      /** vec2, atlas uv. */
      readonly texsize: number;
      /** vec4, the SDF glyph's color; unused for a raster glyph, whose texel is its color. */
      readonly tint: number;
      /** float, > 0.5 for an SDF glyph. */
      readonly sdf: number;
      /** vec2, terminal space. */
      readonly cellpos: number;
    };
    /** Background rectangles (selection included), `rectStride` floats each: x, y, width, height, r, g, b, a. */
    readonly backgrounds: Float32Array;
    /** Cursor rectangles in the same layout; empty while a blinking cursor is hidden. */
    readonly cursor: Float32Array;
    readonly rectStride: number;
    /** Atlas pages by `texpage`; re-upload a page when its `version` changes. */
    readonly pages: ReadonlyArray<{ readonly canvas: HTMLCanvasElement, readonly version: number }>;
    /** An SDF texel's alpha at the glyph edge: coverage is a smoothstep around it. */
    readonly sdfEdge: number;
  }

  export interface IWebglAddonOptions {
    /**
     * Whether to draw custom glyphs instead of using the font for the following
     * unicode ranges:
     *
     * - Box Drawing (U+2500-U+257F)
     * - Block Elements (U+2580-U+259F)
     * - Braille Patterns (U+2800-U+28FF)
     * - Powerline Symbols (U+E0A0-U+E0D4, Private Use Area with widespread
     *   adoption)
     * - Progress Indicators (U+EE00-U+EE0B, Private Use Area initially added in
     *   [Fira Code](https://github.com/tonsky/FiraCode) and later
     *   [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts/pull/1733)).
     * - Git Branch Symbols (U+F5D0-U+F60D, Private Use Area initially adopted
     *   in [Kitty in 2024](https://github.com/kovidgoyal/kitty/pull/7681) by
     *   author of [vim-flog](https://github.com/rbong/vim-flog))
     * - Symbols for Legacy Computing (U+1FB00-U+1FBFF)
     *
     * This will typically result in better rendering with continuous lines,
     * even when line height and letter spacing is used. The default is true.
     */
    customGlyphs?: boolean;

    /**
     * Whether to enable the preserveDrawingBuffer flag when creating the WebGL
     * context. This may be useful in tests. This default is false.
     */
    preserveDrawingBuffer?: boolean

    /**
     * Fork addition: render eligible glyphs via signed distance fields so text stays crisp when
     * the terminal is rendered at scales other than 1:1 (e.g. as a texture in a 3D scene). Color
     * emoji, custom glyphs (box drawing/powerline) and decorated cells (underline etc.) keep the
     * pixel-accurate raster path. The default is false.
     */
    sdf?: boolean

    /**
     * Fork addition: the base font size in pixels that SDF glyphs are rasterized at, independent
     * of the terminal's font size and devicePixelRatio. Lower values produce a smaller atlas that
     * the SDF shader can still magnify with crisp edges; higher values preserve more corner
     * detail. The default is 32.
     */
    sdfGlyphSize?: number
  }
}

