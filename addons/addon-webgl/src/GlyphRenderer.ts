/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */
import { TextureAtlas } from './TextureAtlas';
import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { NULL_CELL_CODE } from 'common/buffer/Constants';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { Terminal } from '@xterm/xterm';
import { IRenderModel, IWebGL2RenderingContext, IWebGLVertexArrayObject, type IRasterizedGlyph, type ITextureAtlas } from './Types';
import { createProgram, GLTexture, PROJECTION_MATRIX } from './WebglUtils';
import { SDF_CUTOFF } from './SdfGlyphRasterizer';
import type { ILogService, IOptionsService } from 'common/services/Services';
import { allowRescaling, throwIfFalsy } from 'browser/renderer/shared/RendererUtils';

interface IVertices {
  attributes: Float32Array;
  /**
   * These buffers are the ones used to bind to WebGL, the reason there are
   * multiple is to allow double buffering to work as you cannot modify the
   * buffer while it's being used by the GPU. Having multiple lets us start
   * working on the next frame.
   */
  attributesBuffers: Float32Array[];
  count: number;
}

const enum VertexAttribLocations {
  UNIT_QUAD = 0,
  CELL_POSITION = 1,
  OFFSET = 2,
  SIZE = 3,
  TEXPAGE = 4,
  TEXCOORD = 5,
  TEXSIZE = 6,
  TINT = 7,
  SDF = 8
}

const vertexShaderSource = `#version 300 es
layout (location = ${VertexAttribLocations.UNIT_QUAD}) in vec2 a_unitquad;
layout (location = ${VertexAttribLocations.CELL_POSITION}) in vec2 a_cellpos;
layout (location = ${VertexAttribLocations.OFFSET}) in vec2 a_offset;
layout (location = ${VertexAttribLocations.SIZE}) in vec2 a_size;
layout (location = ${VertexAttribLocations.TEXPAGE}) in float a_texpage;
layout (location = ${VertexAttribLocations.TEXCOORD}) in vec2 a_texcoord;
layout (location = ${VertexAttribLocations.TEXSIZE}) in vec2 a_texsize;
layout (location = ${VertexAttribLocations.TINT}) in vec4 a_tint;
layout (location = ${VertexAttribLocations.SDF}) in float a_sdf;

uniform mat4 u_projection;
uniform vec2 u_resolution;

out vec2 v_texcoord;
flat out int v_texpage;
flat out vec4 v_tint;
flat out float v_sdf;

void main() {
  vec2 zeroToOne = (a_offset / u_resolution) + a_cellpos + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_texpage = int(a_texpage);
  v_texcoord = a_texcoord + a_unitquad * a_texsize;
  v_tint = a_tint;
  v_sdf = a_sdf;
}`;

/**
 * The edge threshold for SDF glyphs, matching how SdfGlyphRasterizer encodes distances:
 * alpha = 1 - SDF_CUTOFF at the glyph edge.
 */
const SDF_EDGE = (1 - SDF_CUTOFF).toFixed(4);

function createFragmentShaderSource(maxFragmentShaderTextureUnits: number): string {
  let textureConditionals = '';
  for (let i = 1; i < maxFragmentShaderTextureUnits; i++) {
    textureConditionals += ` else if (v_texpage == ${i}) { texel = texture(u_texture[${i}], v_texcoord); }`;
  }
  return (`#version 300 es
precision mediump float;

in vec2 v_texcoord;
flat in int v_texpage;
flat in vec4 v_tint;
flat in float v_sdf;

uniform sampler2D u_texture[${maxFragmentShaderTextureUnits}];

out vec4 outColor;

void main() {
  vec4 texel;
  if (v_texpage == 0) {
    texel = texture(u_texture[0], v_texcoord);
  } ${textureConditionals}
  if (v_sdf > 0.5) {
    // Signed distance field glyph: the alpha channel is the distance and the color comes from
    // the per-instance tint. fwidth keeps the antialiased edge ~1 output pixel wide at any scale.
    float d = texel.a;
    float w = max(fwidth(d), 0.0001);
    float coverage = smoothstep(${SDF_EDGE} - w, ${SDF_EDGE} + w, d);
    outColor = vec4(v_tint.rgb, coverage * v_tint.a);
  } else {
    outColor = texel;
  }
}`);
}

const enum Constants {
  INDICES_PER_CELL = 16,
  BYTES_PER_CELL = INDICES_PER_CELL * 4/* Float32Array.BYTES_PER_ELEMENT */,
  CELL_POSITION_INDICES = 2
}

// Work variables to avoid garbage collection
let $i = 0;
let $glyph: IRasterizedGlyph | undefined = undefined;
let $leftCellPadding = 0;
let $clippedPixels = 0;

export class GlyphRenderer extends Disposable {
  private readonly _program: WebGLProgram;
  private readonly _vertexArrayObject: IWebGLVertexArrayObject;
  private readonly _projectionLocation: WebGLUniformLocation;
  private readonly _resolutionLocation: WebGLUniformLocation;
  private readonly _textureLocation: WebGLUniformLocation;
  private readonly _atlasTextures: GLTexture[];
  private readonly _attributesBuffer: WebGLBuffer;

  private _atlas: ITextureAtlas | undefined;
  private _activeBuffer: number = 0;
  private readonly _vertices: IVertices = {
    count: 0,
    attributes: new Float32Array(0),
    attributesBuffers: [
      new Float32Array(0),
      new Float32Array(0)
    ]
  };

  constructor(
    private readonly _terminal: Terminal,
    private readonly _gl: IWebGL2RenderingContext,
    private _dimensions: IRenderDimensions,
    private readonly _optionsService: IOptionsService,
    private readonly _logService: ILogService
  ) {
    super();

    const gl = this._gl;

    if (TextureAtlas.maxAtlasPages === undefined) {
      // Typically 8 or 16
      TextureAtlas.maxAtlasPages = Math.min(32, throwIfFalsy(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number | null));
      // Almost all clients will support >= 4096
      TextureAtlas.maxTextureSize = throwIfFalsy(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number | null);
    }

    this._program = throwIfFalsy(createProgram(gl, vertexShaderSource, createFragmentShaderSource(TextureAtlas.maxAtlasPages), this._logService));
    this._register(toDisposable(() => gl.deleteProgram(this._program)));

    // Uniform locations
    this._projectionLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_projection'));
    this._resolutionLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_resolution'));
    this._textureLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_texture'));

    // Create and set the vertex array object
    const vertexArrayObject = this._vertexArrayObject = gl.createVertexArray();
    this._register(toDisposable(() => gl.deleteVertexArray(vertexArrayObject)));
    gl.bindVertexArray(vertexArrayObject);

    // Setup a_unitquad, this defines the 4 vertices of a rectangle
    const unitQuadVertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const unitQuadVerticesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(unitQuadVerticesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(VertexAttribLocations.UNIT_QUAD);
    gl.vertexAttribPointer(VertexAttribLocations.UNIT_QUAD, 2, this._gl.FLOAT, false, 0, 0);

    // Setup the unit quad element array buffer, this points to indices in
    // unitQuadVertices to allow is to draw 2 triangles from the vertices via a
    // triangle strip
    const unitQuadElementIndices = new Uint8Array([0, 1, 2, 3]);
    const elementIndicesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(elementIndicesBuffer)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, unitQuadElementIndices, gl.STATIC_DRAW);

    // Setup attributes
    this._attributesBuffer = throwIfFalsy(gl.createBuffer());
    this._register(toDisposable(() => gl.deleteBuffer(this._attributesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.enableVertexAttribArray(VertexAttribLocations.OFFSET);
    gl.vertexAttribPointer(VertexAttribLocations.OFFSET, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 0);
    gl.vertexAttribDivisor(VertexAttribLocations.OFFSET, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.SIZE);
    gl.vertexAttribPointer(VertexAttribLocations.SIZE, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.SIZE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TEXPAGE);
    gl.vertexAttribPointer(VertexAttribLocations.TEXPAGE, 1, gl.FLOAT, false, Constants.BYTES_PER_CELL, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TEXPAGE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TEXCOORD);
    gl.vertexAttribPointer(VertexAttribLocations.TEXCOORD, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 5 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TEXCOORD, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TEXSIZE);
    gl.vertexAttribPointer(VertexAttribLocations.TEXSIZE, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 7 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TEXSIZE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.TINT);
    gl.vertexAttribPointer(VertexAttribLocations.TINT, 4, gl.FLOAT, false, Constants.BYTES_PER_CELL, 9 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.TINT, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.SDF);
    gl.vertexAttribPointer(VertexAttribLocations.SDF, 1, gl.FLOAT, false, Constants.BYTES_PER_CELL, 13 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.SDF, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.CELL_POSITION);
    gl.vertexAttribPointer(VertexAttribLocations.CELL_POSITION, 2, gl.FLOAT, false, Constants.BYTES_PER_CELL, 14 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.CELL_POSITION, 1);

    // Setup static uniforms
    gl.useProgram(this._program);
    const textureUnits = new Int32Array(TextureAtlas.maxAtlasPages);
    for (let i = 0; i < TextureAtlas.maxAtlasPages; i++) {
      textureUnits[i] = i;
    }
    gl.uniform1iv(this._textureLocation, textureUnits);
    gl.uniformMatrix4fv(this._projectionLocation, false, PROJECTION_MATRIX);

    // Setup 1x1 red pixel textures for all potential atlas pages, if one of these invalid textures
    // is ever drawn it will show characters as red rectangles.
    this._atlasTextures = [];
    for (let i = 0; i < TextureAtlas.maxAtlasPages; i++) {
      const glTexture = new GLTexture(throwIfFalsy(gl.createTexture()));
      this._register(toDisposable(() => gl.deleteTexture(glTexture.texture)));
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, glTexture.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]));
      this._atlasTextures[i] = glTexture;
    }

    // Allow drawing of transparent texture
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Set viewport
    this.handleResize();
  }

  public beginFrame(): boolean {
    return this._atlas ? this._atlas.beginFrame() : true;
  }

  public updateCell(x: number, y: number, code: number, bg: number, fg: number, ext: number, chars: string, width: number, lastBg: number): void {
    // Since this function is called for every cell (`rows*cols`), it must be very optimized. It
    // should not instantiate any variables unless a new glyph is drawn to the cache where the
    // slight slowdown is acceptable for the developer ergonomics provided as it's a one-off for
    // each glyph.
    this._updateCell(this._vertices.attributes, x, y, code, bg, fg, ext, chars, width, lastBg);
  }

  private _updateCell(array: Float32Array, x: number, y: number, code: number | undefined, bg: number, fg: number, ext: number, chars: string, width: number, lastBg: number): void {
    $i = (y * this._terminal.cols + x) * Constants.INDICES_PER_CELL;

    // Exit early if this is a null character, allow space character to continue as it may have
    // underline/strikethrough styles
    if (code === NULL_CELL_CODE || code === undefined/* This is used for the right side of wide chars */) {
      array.fill(0, $i, $i + Constants.INDICES_PER_CELL - Constants.CELL_POSITION_INDICES);
      return;
    }

    if (!this._atlas) {
      return;
    }

    // Get the glyph
    if (chars && chars.length > 1) {
      $glyph = this._atlas.getRasterizedGlyphCombinedChar(chars, bg, fg, ext, false, this._terminal.element);
    } else {
      $glyph = this._atlas.getRasterizedGlyph(code, bg, fg, ext, false, this._terminal.element);
    }

    $leftCellPadding = Math.floor((this._dimensions.device.cell.width - this._dimensions.device.char.width) / 2);
    if (bg !== lastBg && $glyph.offset.x > $leftCellPadding) {
      // $clippedPixels is in render (device) pixels; texture coordinates need atlas pixels, so
      // divide by renderScale when adjusting them (renderScale is 1 for raster glyphs)
      $clippedPixels = $glyph.offset.x - $leftCellPadding;
      // a_origin
      array[$i    ] = -($glyph.offset.x - $clippedPixels) + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph.offset.y + this._dimensions.device.char.top;
      // a_size
      array[$i + 2] = ($glyph.size.x * $glyph.renderScale - $clippedPixels) / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph.size.y * $glyph.renderScale / this._dimensions.device.canvas.height;
      // a_texpage
      array[$i + 4] = $glyph.texturePage;
      // a_texcoord
      array[$i + 5] = $glyph.texturePositionClipSpace.x + ($clippedPixels / $glyph.renderScale) / this._atlas.pages[$glyph.texturePage].canvas.width;
      array[$i + 6] = $glyph.texturePositionClipSpace.y;
      // a_texsize
      array[$i + 7] = $glyph.sizeClipSpace.x - ($clippedPixels / $glyph.renderScale) / this._atlas.pages[$glyph.texturePage].canvas.width;
      array[$i + 8] = $glyph.sizeClipSpace.y;
    } else {
      // a_origin
      array[$i    ] = -$glyph.offset.x + this._dimensions.device.char.left;
      array[$i + 1] = -$glyph.offset.y + this._dimensions.device.char.top;
      // a_size
      array[$i + 2] = $glyph.size.x * $glyph.renderScale / this._dimensions.device.canvas.width;
      array[$i + 3] = $glyph.size.y * $glyph.renderScale / this._dimensions.device.canvas.height;
      // a_texpage
      array[$i + 4] = $glyph.texturePage;
      // a_texcoord
      array[$i + 5] = $glyph.texturePositionClipSpace.x;
      array[$i + 6] = $glyph.texturePositionClipSpace.y;
      // a_texsize
      array[$i + 7] = $glyph.sizeClipSpace.x;
      array[$i + 8] = $glyph.sizeClipSpace.y;
    }
    // a_tint + a_sdf
    array[$i + 9] = $glyph.tintR;
    array[$i + 10] = $glyph.tintG;
    array[$i + 11] = $glyph.tintB;
    array[$i + 12] = $glyph.tintA;
    array[$i + 13] = $glyph.sdf ? 1 : 0;
    // a_cellpos only changes on resize

    // Reduce scale horizontally for wide glyphs printed in cells that would overlap with the
    // following cell (ie. the width is not 2).
    if (this._optionsService.rawOptions.rescaleOverlappingGlyphs) {
      if (allowRescaling(code, width, $glyph.size.x * $glyph.renderScale, this._dimensions.device.cell.width)) {
        array[$i + 2] = (this._dimensions.device.cell.width - 1) / this._dimensions.device.canvas.width; // - 1 to improve readability
      }
    }
  }

  public clear(): void {
    const terminal = this._terminal;
    const newCount = terminal.cols * terminal.rows * Constants.INDICES_PER_CELL;

    // Clear vertices
    if (this._vertices.count !== newCount) {
      this._vertices.attributes = new Float32Array(newCount);
    } else {
      this._vertices.attributes.fill(0);
    }
    let i = 0;
    for (; i < this._vertices.attributesBuffers.length; i++) {
      if (this._vertices.count !== newCount) {
        this._vertices.attributesBuffers[i] = new Float32Array(newCount);
      } else {
        this._vertices.attributesBuffers[i].fill(0);
      }
    }
    this._vertices.count = newCount;
    i = 0;
    for (let y = 0; y < terminal.rows; y++) {
      for (let x = 0; x < terminal.cols; x++) {
        this._vertices.attributes[i + 14] = x / terminal.cols;
        this._vertices.attributes[i + 15] = y / terminal.rows;
        i += Constants.INDICES_PER_CELL;
      }
    }
  }

  public handleResize(): void {
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.viewport(0, 0, this._dimensions.device.canvas.width, this._dimensions.device.canvas.height);
    gl.uniform2f(this._resolutionLocation, this._dimensions.device.canvas.width, this._dimensions.device.canvas.height);
    this.clear();
  }

  public render(renderModel: IRenderModel): void {
    if (!this._atlas) {
      return;
    }

    const gl = this._gl;

    gl.useProgram(this._program);
    gl.bindVertexArray(this._vertexArrayObject);

    // Alternate buffers each frame as the active buffer gets locked while it's in use by the GPU
    this._activeBuffer = (this._activeBuffer + 1) % 2;
    const activeBuffer = this._vertices.attributesBuffers[this._activeBuffer];

    // Copy data for each cell of each line up to its line length (the last non-whitespace cell)
    // from the attributes buffer into activeBuffer, which is the one that gets bound to the GPU.
    // The reasons for this are as follows:
    // - So the active buffer can be alternated so we don't get blocked on rendering finishing
    // - To copy either the normal attributes buffer or the selection attributes buffer when there
    //   is a selection
    // - So we don't send vertices for all the line-ending whitespace to the GPU
    let bufferLength = 0;
    for (let y = 0; y < renderModel.lineLengths.length; y++) {
      const si = y * this._terminal.cols * Constants.INDICES_PER_CELL;
      const sub = this._vertices.attributes.subarray(si, si + renderModel.lineLengths[y] * Constants.INDICES_PER_CELL);
      activeBuffer.set(sub, bufferLength);
      bufferLength += sub.length;
    }

    // Bind the attributes buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, activeBuffer.subarray(0, bufferLength), gl.STREAM_DRAW);

    // Bind the atlas page texture if they have changed. AtlasPage.version is globally
    // monotonic, so a page object swap at the same index (which happens after a page merge)
    // is detected by the same comparison.
    for (let i = 0; i < this._atlas.pages.length; i++) {
      if (this._atlas.pages[i].version !== this._atlasTextures[i].version) {
        this._bindAtlasPageTexture(gl, this._atlas, i);
      }
    }

    // Draw the viewport
    gl.drawElementsInstanced(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, bufferLength / Constants.INDICES_PER_CELL);
  }

  public setAtlas(atlas: ITextureAtlas): void {
    this._atlas = atlas;
    this.invalidateAtlasTextures();
  }

  public invalidateAtlasTextures(): void {
    for (const glTexture of this._atlasTextures) {
      glTexture.version = -1;
    }
  }

  private _bindAtlasPageTexture(gl: IWebGL2RenderingContext, atlas: ITextureAtlas, i: number): void {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, this._atlasTextures[i].texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.pages[i].canvas);
    this._atlasTextures[i].version = atlas.pages[i].version;
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._dimensions = dimensions;
  }
}
