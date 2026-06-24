import { beginSliceProfileCycle, markSliceBuildComplete, recordStage } from "./perfProfiler";

export type Vec3 = [number, number, number];

export const COLOR_SPACES = [
  {
    id: "srgb",
    label: "sRGB",
    axes: ["R", "G", "B"],
    summary: "Display RGB cube in gamma-encoded sRGB coordinates.",
  },
  {
    id: "hsv",
    label: "HSV",
    axes: ["Hue x Sat", "Hue y Sat", "Value"],
    summary: "Cylindrical hue and saturation with value as height.",
  },
  {
    id: "hsl",
    label: "HSL",
    axes: ["Hue x Sat", "Hue y Sat", "Lightness"],
    summary: "Cylindrical hue and saturation with HSL lightness.",
  },
  {
    id: "hsluv",
    label: "HSLuv",
    axes: ["Hue x Sat", "Hue y Sat", "L*"],
    summary: "Perceptual HSLuv coordinates derived from CIELUV.",
  },
  {
    id: "oklab",
    label: "Oklab",
    axes: ["L", "a", "b"],
    summary: "Oklab coordinates converted from linear sRGB.",
  },
  {
    id: "oklch",
    label: "Oklch",
    axes: ["Hue x Chroma", "Hue y Chroma", "L"],
    summary: "Oklch polar coordinates embedded as hue angle, chroma radius, and lightness.",
  },
  {
    id: "ycbcr",
    label: "YCbCr",
    axes: ["Y", "Cb", "Cr"],
    summary: "Normalized BT.709 luma and chroma coordinates.",
  },
] as const;

export type ColorSpaceId = (typeof COLOR_SPACES)[number]["id"];

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface ColorVolumeData {
  id: ColorSpaceId;
  label: string;
  axes: readonly [string, string, string];
  sceneAxes: readonly [string, string, string];
  count: number;
  surface: ColorSurfaceMesh;
  positions: Float32Array;
  colors: Float32Array;
  rawBounds: Bounds;
  sceneRawBounds: Bounds;
  normalizedBounds: Bounds;
  sceneBounds: Bounds;
  sceneToRawAxes: AxisOrder;
  maxExtent: number;
  sceneScale: number;
  occupiedVolume: number;
  polarRadiusMax: number;
  generatedAt: number;
}

export interface ColorSurfaceMesh {
  positions: Float32Array;
  colors: Float32Array;
  cellCount: number;
  faceCount: number;
  vertexCount: number;
}

export type SliceAxis = 0 | 1 | 2;
export type AxisOrder = readonly [SliceAxis, SliceAxis, SliceAxis];
export type SliceMode = "component" | "cyl-height" | "cyl-hue" | "cyl-saturation";

export interface ColorSliceData {
  axis: SliceAxis;
  axes2D: [SliceAxis, SliceAxis];
  mode: SliceMode;
  label: string;
  valueLabel: string;
  previewAxes: [string, string];
  position: number;
  planeValue: number;
  size: number;
  pixels: Uint8ClampedArray;
  insideMask: Uint8Array;
  filledCells: number;
}

export interface BuildColorVolumeOptions {
  spaceId: ColorSpaceId;
}

const TAU = Math.PI * 2;
const SURFACE_RESOLUTION = 34;
const TARGET_SCENE_VOLUME = 4;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;
const D65: Vec3 = [0.95047, 1, 1.08883];
const D65_UV = uvPrimeFromXyz(D65);

const HSLUV_M = [
  [3.240969941904521, -1.537383177570093, -0.498610760293],
  [-0.96924363628087, 1.87596750150772, 0.041555057407175],
  [0.055630079696993, -0.20397695888897, 1.056971514242878],
] as const;

export function getColorSpaceMeta(id: ColorSpaceId) {
  return COLOR_SPACES.find((space) => space.id === id) ?? COLOR_SPACES[0];
}

type NativeCylindricalSpaceId = Extract<ColorSpaceId, "hsv" | "hsl" | "hsluv">;
type CylindricalSpaceId = NativeCylindricalSpaceId | Extract<ColorSpaceId, "oklch">;

export function isCylindricalColorSpace(id: ColorSpaceId): id is CylindricalSpaceId {
  return id === "hsv" || id === "hsl" || id === "hsluv" || id === "oklch";
}

export function getCylindricalHeightLabel(id: CylindricalSpaceId) {
  if (id === "hsv") {
    return "Value";
  }
  if (id === "hsl") {
    return "Lightness";
  }
  if (id === "oklch") {
    return "L";
  }
  return "L*";
}

export function getCylindricalRadiusLabel(id: CylindricalSpaceId) {
  return id === "oklch" ? "Chroma" : "Sat";
}

function isNativeCylindricalSurfaceSpace(id: ColorSpaceId): id is NativeCylindricalSpaceId {
  return id === "hsv" || id === "hsl" || id === "hsluv";
}

function getSceneToRawAxes(id: ColorSpaceId): AxisOrder {
  if (id === "hsv" || id === "hsl" || id === "hsluv" || id === "oklch") {
    return [0, 2, 1];
  }

  if (id === "oklab" || id === "ycbcr") {
    return [1, 0, 2];
  }

  return [0, 1, 2];
}

function reorderTuple<T>(values: readonly [T, T, T], order: AxisOrder): readonly [T, T, T] {
  return [values[order[0]], values[order[1]], values[order[2]]];
}

function reorderBounds(bounds: Bounds, order: AxisOrder): Bounds {
  return {
    min: [bounds.min[order[0]], bounds.min[order[1]], bounds.min[order[2]]],
    max: [bounds.max[order[0]], bounds.max[order[1]], bounds.max[order[2]]],
  };
}

function isOddAxisOrder(order: AxisOrder) {
  let inversions = 0;

  for (let a = 0; a < order.length; a += 1) {
    for (let b = a + 1; b < order.length; b += 1) {
      if (order[a] > order[b]) {
        inversions += 1;
      }
    }
  }

  return inversions % 2 === 1;
}

function correctSurfaceWinding(surface: ColorSurfaceMesh, sceneToRawAxes: AxisOrder) {
  if (!isOddAxisOrder(sceneToRawAxes)) {
    return;
  }

  for (let offset = 0; offset < surface.positions.length; offset += 9) {
    swapVector3(surface.positions, offset + 3, offset + 6);
    swapVector3(surface.colors, offset + 3, offset + 6);
  }
}

function swapVector3(values: Float32Array, a: number, b: number) {
  for (let axis = 0; axis < 3; axis += 1) {
    const temp = values[a + axis];
    values[a + axis] = values[b + axis];
    values[b + axis] = temp;
  }
}

export function buildColorVolume({ spaceId }: BuildColorVolumeOptions): ColorVolumeData {
  const safeResolution = SURFACE_RESOLUTION;
  const total = safeResolution ** 3;
  const raw = new Float64Array(total * 3);
  const colors = new Float32Array(total * 3);
  const sourceToSample = new Int32Array(total);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const denom = safeResolution - 1;
  const meta = getColorSpaceMeta(spaceId);
  const sceneToRawAxes = getSceneToRawAxes(spaceId);
  let cursor = 0;
  let polarRadiusMax = 0;
  sourceToSample.fill(-1);

  for (let x = 0; x < safeResolution; x += 1) {
    const a = x / denom;
    for (let y = 0; y < safeResolution; y += 1) {
      const b = y / denom;
      for (let z = 0; z < safeResolution; z += 1) {
        const c = z / denom;
        const rgb = [a, b, c] as Vec3;
        const mapped = mapRgbToSpace(spaceId, rgb);

        if (!Number.isFinite(mapped[0]) || !Number.isFinite(mapped[1]) || !Number.isFinite(mapped[2])) {
          continue;
        }

        const offset = cursor * 3;
        sourceToSample[sourceGridIndex(x, y, z, safeResolution)] = cursor;
        raw[offset] = mapped[0];
        raw[offset + 1] = mapped[1];
        raw[offset + 2] = mapped[2];
        colors[offset] = clamp01(rgb[0]);
        colors[offset + 1] = clamp01(rgb[1]);
        colors[offset + 2] = clamp01(rgb[2]);

        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], mapped[axis]);
          max[axis] = Math.max(max[axis], mapped[axis]);
        }

        polarRadiusMax = Math.max(polarRadiusMax, Math.hypot(mapped[0], mapped[1]));
        cursor += 1;
      }
    }
  }

  const rawBounds = sanitizeBounds({ min, max });
  const center: Vec3 = [
    (rawBounds.min[0] + rawBounds.max[0]) * 0.5,
    (rawBounds.min[1] + rawBounds.max[1]) * 0.5,
    (rawBounds.min[2] + rawBounds.max[2]) * 0.5,
  ];
  const extent: Vec3 = [
    rawBounds.max[0] - rawBounds.min[0],
    rawBounds.max[1] - rawBounds.min[1],
    rawBounds.max[2] - rawBounds.min[2],
  ];
  const maxExtent = Math.max(extent[0], extent[1], extent[2], 1e-9);
  const positions = new Float32Array(cursor * 3);
  const normalizedMin: Vec3 = [Infinity, Infinity, Infinity];
  const normalizedMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  const sceneMin: Vec3 = [Infinity, Infinity, Infinity];
  const sceneMax: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < cursor; index += 1) {
    const offset = index * 3;
    const normalizedRaw: Vec3 = [0, 0, 0];

    for (let axis = 0; axis < 3; axis += 1) {
      const normalized = ((raw[offset + axis] - center[axis]) / maxExtent) * 2;
      normalizedRaw[axis] = normalized;
      normalizedMin[axis] = Math.min(normalizedMin[axis], normalized);
      normalizedMax[axis] = Math.max(normalizedMax[axis], normalized);
    }

    for (let sceneAxis = 0; sceneAxis < 3; sceneAxis += 1) {
      const normalized = normalizedRaw[sceneToRawAxes[sceneAxis]];
      positions[offset + sceneAxis] = normalized;
      sceneMin[sceneAxis] = Math.min(sceneMin[sceneAxis], normalized);
      sceneMax[sceneAxis] = Math.max(sceneMax[sceneAxis], normalized);
    }
  }

  const sampleColors = colors.slice(0, cursor * 3);
  const unscaledBounds = sanitizeBounds({ min: normalizedMin, max: normalizedMax });
  const unscaledSceneBounds = sanitizeBounds({ min: sceneMin, max: sceneMax });
  const occupiedVolume = estimateOccupiedVolume(positions, unscaledSceneBounds);
  const sceneScale = clamp(
    Math.cbrt(TARGET_SCENE_VOLUME / Math.max(occupiedVolume, 1e-6)),
    0.72,
    2.35,
  );

  for (let index = 0; index < positions.length; index += 1) {
    positions[index] *= sceneScale;
  }

  const scaledBounds = scaleBounds(unscaledBounds, sceneScale);
  const scaledSceneBounds = scaleBounds(unscaledSceneBounds, sceneScale);
  const surface =
    isNativeCylindricalSurfaceSpace(spaceId)
      ? buildCylindricalSurfaceMesh({
          spaceId,
          resolution: safeResolution,
          center,
          maxExtent,
          sceneScale,
          sceneToRawAxes,
        })
      : buildBoundarySurfaceMesh({
          positions,
          colors: sampleColors,
          gridSize: safeResolution,
          sourceToSample,
        });
  correctSurfaceWinding(surface, sceneToRawAxes);

  return {
    id: spaceId,
    label: meta.label,
    axes: meta.axes,
    sceneAxes: reorderTuple(meta.axes, sceneToRawAxes),
    count: cursor,
    surface,
    positions,
    colors: sampleColors,
    rawBounds,
    sceneRawBounds: reorderBounds(rawBounds, sceneToRawAxes),
    normalizedBounds: scaledBounds,
    sceneBounds: scaledSceneBounds,
    sceneToRawAxes,
    maxExtent,
    sceneScale,
    occupiedVolume,
    polarRadiusMax: Math.max(polarRadiusMax, 1e-9),
    generatedAt: performance.now(),
  };
}

export function buildColorSlice(
  data: ColorVolumeData,
  axis: SliceAxis,
  position: number,
  size = 144,
  mode: SliceMode = "component",
): ColorSliceData {
  beginSliceProfileCycle(`${data.label} / ${mode}`);
  const start = performance.now();
  const slice = buildColorSliceInternal(data, axis, position, size, mode);
  recordStage("slice data: total buildColorSlice", performance.now() - start);
  markSliceBuildComplete(`${data.label} / ${slice.label}`);
  return slice;
}

export function buildEmptyColorSlice(
  data: ColorVolumeData,
  axis: SliceAxis,
  position: number,
  mode: SliceMode = "component",
): ColorSliceData {
  const safePosition = clamp01(position);
  const emptyPixels = new Uint8ClampedArray(4);
  const emptyMask = new Uint8Array(1);

  if (isCylindricalColorSpace(data.id)) {
    if (data.id === "oklch") {
      if (mode === "cyl-hue") {
        return makeEmptySlice({
          axis: 2,
          axes2D: [0, 2],
          mode,
          label: "Hue section",
          valueLabel: `${Math.round(safePosition * 360)} deg`,
          previewAxes: ["Chroma", "L"],
          position: safePosition,
          planeValue: safePosition,
          pixels: emptyPixels,
          insideMask: emptyMask,
        });
      }

      if (mode === "cyl-saturation") {
        const chroma = safePosition * data.polarRadiusMax;
        return makeEmptySlice({
          axis: 2,
          axes2D: [0, 2],
          mode,
          label: "Chroma section",
          valueLabel: formatSliceNumber(chroma),
          previewAxes: ["Hue", "L"],
          position: safePosition,
          planeValue: chroma,
          pixels: emptyPixels,
          insideMask: emptyMask,
        });
      }

      const lightness = data.rawBounds.min[2] + safePosition * (data.rawBounds.max[2] - data.rawBounds.min[2]);
      return makeEmptySlice({
        axis: 2,
        axes2D: [0, 1],
        mode: "cyl-height",
        label: "L section",
        valueLabel: formatSliceNumber(lightness),
        previewAxes: [data.axes[0], data.axes[1]],
        position: safePosition,
        planeValue: lightness,
        pixels: emptyPixels,
        insideMask: emptyMask,
      });
    }

    const heightLabel = getCylindricalHeightLabel(data.id);
    const radiusLabel = getCylindricalRadiusLabel(data.id);

    if (mode === "cyl-hue") {
      return makeEmptySlice({
        axis: 2,
        axes2D: [0, 2],
        mode,
        label: "Hue section",
        valueLabel: `${Math.round(safePosition * 360)} deg`,
        previewAxes: [radiusLabel, heightLabel],
        position: safePosition,
        planeValue: safePosition,
        pixels: emptyPixels,
        insideMask: emptyMask,
      });
    }

    if (mode === "cyl-saturation") {
      return makeEmptySlice({
        axis: 2,
        axes2D: [0, 2],
        mode,
        label: `${radiusLabel} section`,
        valueLabel: safePosition.toFixed(3),
        previewAxes: ["Hue", heightLabel],
        position: safePosition,
        planeValue: safePosition,
        pixels: emptyPixels,
        insideMask: emptyMask,
      });
    }

    return makeEmptySlice({
      axis: 2,
      axes2D: [0, 1],
      mode: "cyl-height",
      label: `${heightLabel} section`,
      valueLabel: safePosition.toFixed(3),
      previewAxes: [data.axes[0], data.axes[1]],
      position: safePosition,
      planeValue: safePosition,
      pixels: emptyPixels,
      insideMask: emptyMask,
    });
  }

  const axes2D = getSliceAxes(axis);
  const rawValue = data.rawBounds.min[axis] + safePosition * (data.rawBounds.max[axis] - data.rawBounds.min[axis]);

  return makeEmptySlice({
    axis,
    axes2D,
    mode: "component",
    label: `${data.axes[axis]} section`,
    valueLabel: formatSliceNumber(rawValue),
    previewAxes: [data.axes[axes2D[0]], data.axes[axes2D[1]]],
    position: safePosition,
    planeValue: rawValue,
    pixels: emptyPixels,
    insideMask: emptyMask,
  });
}

function makeEmptySlice(slice: Omit<ColorSliceData, "size" | "filledCells">): ColorSliceData {
  return {
    ...slice,
    size: 1,
    filledCells: 0,
  };
}

function buildColorSliceInternal(
  data: ColorVolumeData,
  axis: SliceAxis,
  position: number,
  size = 144,
  mode: SliceMode = "component",
): ColorSliceData {
  if (isCylindricalColorSpace(data.id)) {
    if (data.id === "oklch") {
      if (mode === "cyl-hue") {
        return buildOklchHueSlice(data, position, size);
      }
      if (mode === "cyl-saturation") {
        return buildOklchChromaSlice(data, position, size);
      }
      return buildOklchLightnessSlice(data, position, size);
    }

    if (mode === "cyl-hue") {
      return buildCylindricalHueSlice(data, position, size);
    }
    if (mode === "cyl-saturation") {
      return buildCylindricalSaturationSlice(data, position, size);
    }
    return buildCylindricalHeightSlice(data, position, size);
  }

  const safeSize = Math.max(32, Math.floor(size));
  const bounds = data.normalizedBounds;
  const axes2D = getSliceAxes(axis);
  const uAxis = axes2D[0];
  const vAxis = axes2D[1];
  const min = bounds.min;
  const max = bounds.max;
  const axisExtent = Math.max(max[axis] - min[axis], 1e-9);
  const uExtent = Math.max(max[uAxis] - min[uAxis], 1e-9);
  const vExtent = Math.max(max[vAxis] - min[vAxis], 1e-9);
  const planeValue = min[axis] + clamp01(position) * axisExtent;
  const rawCenter: Vec3 = [
    (data.rawBounds.min[0] + data.rawBounds.max[0]) * 0.5,
    (data.rawBounds.min[1] + data.rawBounds.max[1]) * 0.5,
    (data.rawBounds.min[2] + data.rawBounds.max[2]) * 0.5,
  ];
  const rawPlaneValue = rawCenter[axis] + ((planeValue / data.sceneScale) * data.maxExtent) / 2;
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const previewStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const u0 = min[uAxis] + (x / safeSize) * uExtent;
      const u1 = min[uAxis] + ((x + 1) / safeSize) * uExtent;
      const v0 = min[vAxis] + (y / safeSize) * vExtent;
      const v1 = min[vAxis] + ((y + 1) / safeSize) * vExtent;
      const row = safeSize - 1 - y;
      const pixelOffset = (x + row * safeSize) * 4;
      const preview = sampleSlicePreview(
        data,
        rawCenter,
        axis,
        uAxis,
        vAxis,
        planeValue,
        u0,
        u1,
        v0,
        v1,
      );

      insideMask[x + row * safeSize] = preview.inside ? 1 : 0;
      paintSlicePixelAtOffset(pixels, pixelOffset, preview.rgb);
      filledCells += preview.inside ? 1 : 0;
    }
  }
  recordStage("slice data: cartesian preview raster", performance.now() - previewStart);

  return {
    axis,
    axes2D,
    mode: "component",
    label: `${data.axes[axis]} section`,
    valueLabel: formatSliceNumber(rawPlaneValue),
    previewAxes: [data.axes[axes2D[0]], data.axes[axes2D[1]]],
    position: clamp01(position),
    planeValue,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function buildCylindricalHeightSlice(data: ColorVolumeData, position: number, size = 144): ColorSliceData {
  const safeSize = Math.max(32, Math.floor(size));
  const spaceId = data.id as NativeCylindricalSpaceId;
  const height = clamp01(position);
  const heightLabel = getCylindricalHeightLabel(spaceId);
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const rasterStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const row = safeSize - 1 - y;
      const pixelOffset = (x + row * safeSize) * 4;
      const px = ((x + 0.5) / safeSize) * 2 - 1;
      const py = ((y + 0.5) / safeSize) * 2 - 1;
      const radius = Math.hypot(px, py);

      if (radius <= 1) {
        const hue = radius <= 1e-8 ? 0 : wrap01(Math.atan2(py, px) / TAU);
        const preview = colorFromCylindricalSpace(spaceId, hue, radius, height);
        insideMask[x + row * safeSize] = 1;
        paintSlicePixelAtOffset(pixels, pixelOffset, preview);
        filledCells += 1;
      } else {
        paintSlicePixelAtOffset(pixels, pixelOffset, null);
      }
    }
  }
  recordStage("slice data: cylindrical height preview raster", performance.now() - rasterStart);

  return {
    axis: 2,
    axes2D: [0, 1],
    mode: "cyl-height",
    label: `${heightLabel} section`,
    valueLabel: height.toFixed(3),
    previewAxes: [data.axes[0], data.axes[1]],
    position: height,
    planeValue: height,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function buildCylindricalHueSlice(data: ColorVolumeData, position: number, size = 144): ColorSliceData {
  const safeSize = Math.max(32, Math.floor(size));
  const spaceId = data.id as NativeCylindricalSpaceId;
  const hue = clamp01(position);
  const heightLabel = getCylindricalHeightLabel(spaceId);
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const loopStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const s0 = x / safeSize;
      const s1 = (x + 1) / safeSize;
      const v0 = y / safeSize;
      const v1 = (y + 1) / safeSize;
      const centerS = (s0 + s1) * 0.5;
      const centerV = (v0 + v1) * 0.5;
      const preview = colorFromCylindricalSpace(spaceId, hue, centerS, centerV);
      const row = safeSize - 1 - y;
      const pixelOffset = (x + row * safeSize) * 4;
      insideMask[x + row * safeSize] = 1;
      pixels[pixelOffset] = Math.round(preview[0] * 255);
      pixels[pixelOffset + 1] = Math.round(preview[1] * 255);
      pixels[pixelOffset + 2] = Math.round(preview[2] * 255);
      pixels[pixelOffset + 3] = 255;
      filledCells += 1;
    }
  }
  recordStage("slice data: cylindrical hue preview raster", performance.now() - loopStart);

  return {
    axis: 2,
    axes2D: [0, 2],
    mode: "cyl-hue",
    label: "Hue section",
    valueLabel: `${Math.round(hue * 360)} deg`,
    previewAxes: ["Saturation", heightLabel],
    position: hue,
    planeValue: hue,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function buildCylindricalSaturationSlice(data: ColorVolumeData, position: number, size = 144): ColorSliceData {
  const safeSize = Math.max(32, Math.floor(size));
  const spaceId = data.id as NativeCylindricalSpaceId;
  const saturation = clamp01(position);
  const heightLabel = getCylindricalHeightLabel(spaceId);
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const loopStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const h0 = x / safeSize;
      const h1 = (x + 1) / safeSize;
      const v0 = y / safeSize;
      const v1 = (y + 1) / safeSize;
      const centerH = (h0 + h1) * 0.5;
      const centerV = (v0 + v1) * 0.5;
      const preview = colorFromCylindricalSpace(spaceId, centerH, saturation, centerV);
      const row = safeSize - 1 - y;
      const pixelOffset = (x + row * safeSize) * 4;
      insideMask[x + row * safeSize] = 1;
      pixels[pixelOffset] = Math.round(preview[0] * 255);
      pixels[pixelOffset + 1] = Math.round(preview[1] * 255);
      pixels[pixelOffset + 2] = Math.round(preview[2] * 255);
      pixels[pixelOffset + 3] = 255;
      filledCells += 1;
    }
  }
  recordStage("slice data: cylindrical radius preview raster", performance.now() - loopStart);

  return {
    axis: 2,
    axes2D: [0, 2],
    mode: "cyl-saturation",
    label: "Saturation section",
    valueLabel: saturation.toFixed(3),
    previewAxes: ["Hue", heightLabel],
    position: saturation,
    planeValue: saturation,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function buildOklchLightnessSlice(data: ColorVolumeData, position: number, size = 144): ColorSliceData {
  const safeSize = Math.max(32, Math.floor(size));
  const lightness = data.rawBounds.min[2] + clamp01(position) * (data.rawBounds.max[2] - data.rawBounds.min[2]);
  const xMin = data.rawBounds.min[0];
  const xMax = data.rawBounds.max[0];
  const yMin = data.rawBounds.min[1];
  const yMax = data.rawBounds.max[1];
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const rasterStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const row = safeSize - 1 - y;
      const rawX = xMin + ((x + 0.5) / safeSize) * (xMax - xMin);
      const rawY = yMin + ((y + 0.5) / safeSize) * (yMax - yMin);
      const previewPoint: Vec3 = [rawX, rawY, lightness];
      const preview = previewRgbFromSpacePoint(data.id, previewPoint);
      const inside = rgbFromSpacePoint(data.id, previewPoint) ? 1 : 0;
      insideMask[x + row * safeSize] = inside;
      paintSlicePixel(pixels, safeSize, x, y, preview);
      filledCells += inside;
    }
  }
  recordStage("slice data: oklch L preview raster", performance.now() - rasterStart);

  return {
    axis: 2,
    axes2D: [0, 1],
    mode: "cyl-height",
    label: "L section",
    valueLabel: formatSliceNumber(lightness),
    previewAxes: [data.axes[0], data.axes[1]],
    position: clamp01(position),
    planeValue: lightness,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function buildOklchHueSlice(data: ColorVolumeData, position: number, size = 144): ColorSliceData {
  const safeSize = Math.max(32, Math.floor(size));
  const hue = clamp01(position);
  const chromaMax = data.polarRadiusMax;
  const lMin = data.rawBounds.min[2];
  const lMax = data.rawBounds.max[2];
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const loopStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const c0 = (x / safeSize) * chromaMax;
      const c1 = ((x + 1) / safeSize) * chromaMax;
      const l0 = lMin + (y / safeSize) * (lMax - lMin);
      const l1 = lMin + ((y + 1) / safeSize) * (lMax - lMin);
      const centerC = (c0 + c1) * 0.5;
      const centerL = (l0 + l1) * 0.5;
      const previewPoint = oklchToEmbeddedPoint(centerL, centerC, hue);
      const preview = previewRgbFromSpacePoint(data.id, previewPoint);
      const inside = rgbFromSpacePoint(data.id, previewPoint) ? 1 : 0;
      insideMask[x + (safeSize - 1 - y) * safeSize] = inside;
      paintSlicePixel(pixels, safeSize, x, y, preview);
      filledCells += inside;
    }
  }
  recordStage("slice data: oklch hue preview raster", performance.now() - loopStart);

  return {
    axis: 2,
    axes2D: [0, 2],
    mode: "cyl-hue",
    label: "Hue section",
    valueLabel: `${Math.round(hue * 360)} deg`,
    previewAxes: ["Chroma", "L"],
    position: hue,
    planeValue: hue,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function buildOklchChromaSlice(data: ColorVolumeData, position: number, size = 144): ColorSliceData {
  const safeSize = Math.max(32, Math.floor(size));
  const chroma = clamp01(position) * data.polarRadiusMax;
  const lMin = data.rawBounds.min[2];
  const lMax = data.rawBounds.max[2];
  const pixels = new Uint8ClampedArray(safeSize * safeSize * 4);
  const insideMask = new Uint8Array(safeSize * safeSize);
  let filledCells = 0;

  const loopStart = performance.now();
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const h0 = x / safeSize;
      const h1 = (x + 1) / safeSize;
      const l0 = lMin + (y / safeSize) * (lMax - lMin);
      const l1 = lMin + ((y + 1) / safeSize) * (lMax - lMin);
      const centerH = (h0 + h1) * 0.5;
      const centerL = (l0 + l1) * 0.5;
      const previewPoint = oklchToEmbeddedPoint(centerL, chroma, centerH);
      const preview = previewRgbFromSpacePoint(data.id, previewPoint);
      const inside = rgbFromSpacePoint(data.id, previewPoint) ? 1 : 0;
      insideMask[x + (safeSize - 1 - y) * safeSize] = inside;
      paintSlicePixel(pixels, safeSize, x, y, preview);
      filledCells += inside;
    }
  }
  recordStage("slice data: oklch chroma preview raster", performance.now() - loopStart);

  return {
    axis: 2,
    axes2D: [0, 2],
    mode: "cyl-saturation",
    label: "Chroma section",
    valueLabel: formatSliceNumber(chroma),
    previewAxes: ["Hue", "L"],
    position: clamp01(position),
    planeValue: chroma,
    size: safeSize,
    pixels,
    insideMask,
    filledCells,
  };
}

function paintSlicePixel(
  pixels: Uint8ClampedArray,
  size: number,
  x: number,
  y: number,
  rgb: Vec3 | null,
) {
  const row = size - 1 - y;
  const pixelOffset = (x + row * size) * 4;
  paintSlicePixelAtOffset(pixels, pixelOffset, rgb);
}

function paintSlicePixelAtOffset(pixels: Uint8ClampedArray, pixelOffset: number, rgb: Vec3 | null) {
  if (!rgb) {
    pixels[pixelOffset] = 0;
    pixels[pixelOffset + 1] = 0;
    pixels[pixelOffset + 2] = 0;
    pixels[pixelOffset + 3] = 255;
    return;
  }

  pixels[pixelOffset] = Math.round(rgb[0] * 255);
  pixels[pixelOffset + 1] = Math.round(rgb[1] * 255);
  pixels[pixelOffset + 2] = Math.round(rgb[2] * 255);
  pixels[pixelOffset + 3] = 255;
}

function oklchToEmbeddedPoint(lightness: number, chroma: number, hue: number): Vec3 {
  const angle = wrap01(hue) * TAU;
  return [Math.cos(angle) * chroma, Math.sin(angle) * chroma, lightness];
}

function sampleSlicePreview(
  data: ColorVolumeData,
  rawCenter: Vec3,
  axis: SliceAxis,
  uAxis: SliceAxis,
  vAxis: SliceAxis,
  planeValue: number,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
) {
  const offsets = [0.25, 0.5, 0.75];
  const rgb: Vec3 = [0, 0, 0];
  let insideCount = 0;
  let count = 0;

  for (const yOffset of offsets) {
    for (const xOffset of offsets) {
      const point = pointOnSlice(
        axis,
        uAxis,
        vAxis,
        planeValue,
        u0 + (u1 - u0) * xOffset,
        v0 + (v1 - v0) * yOffset,
      );
      const sample = rgbFromSpacePoint(data.id, normalizedToRaw(point, rawCenter, data.maxExtent, data.sceneScale));
      const preview = previewRgbFromSpacePoint(
        data.id,
        normalizedToRaw(point, rawCenter, data.maxExtent, data.sceneScale),
      );

      if (sample) {
        insideCount += 1;
      }

      if (!preview) {
        continue;
      }

      rgb[0] += preview[0];
      rgb[1] += preview[1];
      rgb[2] += preview[2];
      count += 1;
    }
  }

  if (count === 0) {
    return { rgb: null, inside: false };
  }

  return {
    rgb: [rgb[0] / count, rgb[1] / count, rgb[2] / count] as Vec3,
    inside: insideCount > 0,
  };
}

function normalizedToRaw(point: Vec3, rawCenter: Vec3, maxExtent: number, sceneScale = 1): Vec3 {
  return [
    rawCenter[0] + ((point[0] / sceneScale) * maxExtent) / 2,
    rawCenter[1] + ((point[1] / sceneScale) * maxExtent) / 2,
    rawCenter[2] + ((point[2] / sceneScale) * maxExtent) / 2,
  ];
}

function formatSliceNumber(value: number) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  const abs = Math.abs(value);
  if (abs >= 100) {
    return rounded.toFixed(1);
  }
  return rounded.toFixed(3);
}

function rgbFromSpacePoint(spaceId: ColorSpaceId, point: Vec3): Vec3 | null {
  const rgb = rawRgbFromSpacePoint(spaceId, point);
  return rgb && isDisplayableRgb(rgb) ? clampRgb(rgb) : null;
}

function previewRgbFromSpacePoint(spaceId: ColorSpaceId, point: Vec3): Vec3 | null {
  const rgb = rawRgbFromSpacePoint(spaceId, point);
  return rgb && isFiniteRgb(rgb) ? clampRgb(rgb) : null;
}

function rawRgbFromSpacePoint(spaceId: ColorSpaceId, point: Vec3): Vec3 | null {
  let rgb: Vec3 | null = null;

  switch (spaceId) {
    case "srgb":
      rgb = point;
      break;
    case "hsv": {
      const cylindrical = rawPointToCylindrical(point);
      rgb = cylindrical ? hsvToRgb(cylindrical.h, cylindrical.s, cylindrical.z) : null;
      break;
    }
    case "hsl": {
      const cylindrical = rawPointToCylindrical(point);
      rgb = cylindrical ? hslToRgb(cylindrical.h, cylindrical.s, cylindrical.z) : null;
      break;
    }
    case "hsluv": {
      const cylindrical = rawPointToCylindrical(point);
      rgb = cylindrical ? hsluvToRgb(cylindrical.h, cylindrical.s, cylindrical.z) : null;
      break;
    }
    case "oklab":
      rgb = oklabToRgb(point);
      break;
    case "oklch":
      rgb = oklabToRgb([point[2], point[0], point[1]]);
      break;
    case "ycbcr":
      rgb = ycbcr709ToRgb(point);
      break;
    default:
      rgb = null;
  }

  return rgb;
}

function rawPointToCylindrical([x, y, z]: Vec3): { h: number; s: number; z: number } | null {
  const radius = Math.hypot(x, y);

  if (radius > 1.000001 || z < -0.000001 || z > 1.000001) {
    return null;
  }

  const hue = radius <= 1e-8 ? 0 : wrap01(Math.atan2(y, x) / TAU);
  return {
    h: hue,
    s: clamp01(radius),
    z: clamp01(z),
  };
}

function getSliceAxes(axis: SliceAxis): [SliceAxis, SliceAxis] {
  if (axis === 0) {
    return [1, 2];
  }
  if (axis === 1) {
    return [0, 2];
  }
  return [0, 1];
}

function pointOnSlice(axis: SliceAxis, uAxis: SliceAxis, vAxis: SliceAxis, plane: number, u: number, v: number): Vec3 {
  const point: Vec3 = [0, 0, 0];
  point[axis] = plane;
  point[uAxis] = u;
  point[vAxis] = v;
  return point;
}

interface BuildBoundarySurfaceMeshOptions {
  positions: Float32Array;
  colors: Float32Array;
  gridSize: number;
  sourceToSample: Int32Array;
}

function buildBoundarySurfaceMesh({
  positions,
  colors,
  gridSize,
  sourceToSample,
}: BuildBoundarySurfaceMeshOptions): ColorSurfaceMesh {
  const size = Math.max(2, gridSize);
  const last = size - 1;
  const meshPositions: number[] = [];
  const meshColors: number[] = [];
  let faceCount = 0;

  const addSampleQuad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
    const samples = [a, b, c, a, c, d]
      .map(([x, y, z]) => sourceToSample[sourceGridIndex(x, y, z, size)])
      .filter((sample) => sample >= 0);

    if (samples.length !== 6) {
      return;
    }

    for (const sample of samples) {
      const offset = sample * 3;
      meshPositions.push(positions[offset], positions[offset + 1], positions[offset + 2]);
      meshColors.push(colors[offset], colors[offset + 1], colors[offset + 2]);
    }

    faceCount += 1;
  };

  for (let y = 0; y < last; y += 1) {
    for (let z = 0; z < last; z += 1) {
      addSampleQuad([0, y, z], [0, y, z + 1], [0, y + 1, z + 1], [0, y + 1, z]);
      addSampleQuad([last, y, z], [last, y + 1, z], [last, y + 1, z + 1], [last, y, z + 1]);
    }
  }

  for (let x = 0; x < last; x += 1) {
    for (let z = 0; z < last; z += 1) {
      addSampleQuad([x, 0, z], [x + 1, 0, z], [x + 1, 0, z + 1], [x, 0, z + 1]);
      addSampleQuad([x, last, z], [x, last, z + 1], [x + 1, last, z + 1], [x + 1, last, z]);
    }
  }

  for (let x = 0; x < last; x += 1) {
    for (let y = 0; y < last; y += 1) {
      addSampleQuad([x, y, 0], [x, y + 1, 0], [x + 1, y + 1, 0], [x + 1, y, 0]);
      addSampleQuad([x, y, last], [x + 1, y, last], [x + 1, y + 1, last], [x, y + 1, last]);
    }
  }

  return {
    positions: new Float32Array(meshPositions),
    colors: new Float32Array(meshColors),
    cellCount: size ** 3,
    faceCount,
    vertexCount: meshPositions.length / 3,
  };
}

interface BuildCylindricalSurfaceMeshOptions {
  spaceId: NativeCylindricalSpaceId;
  resolution: number;
  center: Vec3;
  maxExtent: number;
  sceneScale: number;
  sceneToRawAxes: AxisOrder;
}

function buildCylindricalSurfaceMesh({
  spaceId,
  resolution,
  center,
  maxExtent,
  sceneScale,
  sceneToRawAxes,
}: BuildCylindricalSurfaceMeshOptions): ColorSurfaceMesh {
  const hueSegments = Math.max(36, resolution * 2);
  const heightSegments = Math.max(8, resolution - 1);
  const radialSegments = Math.max(8, Math.floor(resolution / 2));
  const meshPositions: number[] = [];
  const meshColors: number[] = [];
  let faceCount = 0;

  const addParamQuad = (
    a: { h: number; r: number; z: number },
    b: { h: number; r: number; z: number },
    c: { h: number; r: number; z: number },
    d: { h: number; r: number; z: number },
  ) => {
    const order = [a, b, c, a, c, d];
    for (const point of order) {
      const rawPosition = cylindricalToCartesian(point.h, point.r, point.z);
      const normalized = normalizeRawPoint(rawPosition, center, maxExtent, sceneScale, sceneToRawAxes);
      const color = colorFromCylindricalSpace(spaceId, point.h, point.r, point.z);
      meshPositions.push(normalized[0], normalized[1], normalized[2]);
      meshColors.push(color[0], color[1], color[2]);
    }
    faceCount += 1;
  };

  for (let h = 0; h < hueSegments; h += 1) {
    const h0 = h / hueSegments;
    const h1 = (h + 1) / hueSegments;

    for (let z = 0; z < heightSegments; z += 1) {
      const z0 = z / heightSegments;
      const z1 = (z + 1) / heightSegments;
      addParamQuad(
        { h: h0, r: 1, z: z0 },
        { h: h1, r: 1, z: z0 },
        { h: h1, r: 1, z: z1 },
        { h: h0, r: 1, z: z1 },
      );
    }

    for (let radius = 0; radius < radialSegments; radius += 1) {
      const r0 = radius / radialSegments;
      const r1 = (radius + 1) / radialSegments;

      addParamQuad(
        { h: h0, r: r0, z: 1 },
        { h: h0, r: r1, z: 1 },
        { h: h1, r: r1, z: 1 },
        { h: h1, r: r0, z: 1 },
      );
      addParamQuad(
        { h: h0, r: r0, z: 0 },
        { h: h1, r: r0, z: 0 },
        { h: h1, r: r1, z: 0 },
        { h: h0, r: r1, z: 0 },
      );
    }
  }

  return {
    positions: new Float32Array(meshPositions),
    colors: new Float32Array(meshColors),
    cellCount: resolution ** 3,
    faceCount,
    vertexCount: meshPositions.length / 3,
  };
}

function normalizeRawPoint(
  point: Vec3,
  center: Vec3,
  maxExtent: number,
  sceneScale = 1,
  sceneToRawAxes: AxisOrder = [0, 1, 2],
): Vec3 {
  const normalizedRaw: Vec3 = [
    ((point[0] - center[0]) / maxExtent) * 2 * sceneScale,
    ((point[1] - center[1]) / maxExtent) * 2 * sceneScale,
    ((point[2] - center[2]) / maxExtent) * 2 * sceneScale,
  ];
  return [
    normalizedRaw[sceneToRawAxes[0]],
    normalizedRaw[sceneToRawAxes[1]],
    normalizedRaw[sceneToRawAxes[2]],
  ];
}

function colorFromCylindricalSpace(spaceId: NativeCylindricalSpaceId, h: number, s: number, z: number): Vec3 {
  if (spaceId === "hsv") {
    return hsvToRgb(h, s, z);
  }
  if (spaceId === "hsl") {
    return hslToRgb(h, s, z);
  }
  return hsluvToRgb(h, s, z);
}

function sourceGridIndex(x: number, y: number, z: number, size: number) {
  return x * size * size + y * size + z;
}

function mapRgbToSpace(spaceId: ColorSpaceId, rgb: Vec3): Vec3 {
  switch (spaceId) {
    case "srgb":
      return rgb;
    case "hsv": {
      const [h, s, v] = rgbToHsv(rgb);
      return cylindricalToCartesian(h, s, v);
    }
    case "hsl": {
      const [h, s, l] = rgbToHsl(rgb);
      return cylindricalToCartesian(h, s, l);
    }
    case "hsluv": {
      const [h, s, l] = rgbToHsluv(rgb);
      return cylindricalToCartesian(h, s, l);
    }
    case "oklab":
      return rgbToOklab(rgb);
    case "oklch": {
      const [l, a, b] = rgbToOklab(rgb);
      return [a, b, l];
    }
    case "ycbcr":
      return rgbToYcbcr709(rgb);
    default:
      return rgb;
  }
}

function cylindricalToCartesian(hue01: number, radius: number, height: number): Vec3 {
  const angle = hue01 * TAU;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius, height];
}

function rgbToXyz([r, g, b]: Vec3): Vec3 {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  return [
    0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl,
    0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl,
    0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl,
  ];
}

function rgbToOklab([r, g, b]: Vec3): Vec3 {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return [
    0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  ];
}

function oklabToRgb([l, a, b]: Vec3): Vec3 {
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;

  const lmsL = lRoot ** 3;
  const lmsM = mRoot ** 3;
  const lmsS = sRoot ** 3;

  return [
    linearToSrgb(4.0767416621 * lmsL - 3.3077115913 * lmsM + 0.2309699292 * lmsS),
    linearToSrgb(-1.2684380046 * lmsL + 2.6097574011 * lmsM - 0.3413193965 * lmsS),
    linearToSrgb(-0.0041960863 * lmsL - 0.7034186147 * lmsM + 1.707614701 * lmsS),
  ];
}

function xyzToLuv([x, y, z]: Vec3): Vec3 {
  const [uPrime, vPrime] = uvPrimeFromXyz([x, y, z]);
  const l = yToLstar(y);

  if (l <= 1e-8) {
    return [0, 0, 0];
  }

  return [l, 13 * l * (uPrime - D65_UV[0]), 13 * l * (vPrime - D65_UV[1])];
}

function uvPrimeFromXyz([x, y, z]: Vec3): [number, number] {
  const denom = x + 15 * y + 3 * z;
  if (Math.abs(denom) < 1e-12) {
    return [0, 0];
  }
  return [(4 * x) / denom, (9 * y) / denom];
}

function rgbToYcbcr709([r, g, b]: Vec3): Vec3 {
  const kr = 0.2126;
  const kb = 0.0722;
  const kg = 1 - kr - kb;
  const y = kr * r + kg * g + kb * b;
  const cb = 0.5 + (b - y) / (2 * (1 - kb));
  const cr = 0.5 + (r - y) / (2 * (1 - kr));
  return [y, cb, cr];
}

function ycbcr709ToRgb([y, cb, cr]: Vec3): Vec3 {
  const kr = 0.2126;
  const kb = 0.0722;
  const kg = 1 - kr - kb;
  const chromaB = cb - 0.5;
  const chromaR = cr - 0.5;
  const r = y + 2 * (1 - kr) * chromaR;
  const b = y + 2 * (1 - kb) * chromaB;
  const g = (y - kr * r - kb * b) / kg;
  return [r, g, b];
}

function rgbToHsv([r, g, b]: Vec3): Vec3 {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const hue = hueFromRgb(r, g, b, max, delta);
  const saturation = max === 0 ? 0 : delta / max;
  return [hue, saturation, max];
}

function rgbToHsl([r, g, b]: Vec3): Vec3 {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) * 0.5;
  const hue = hueFromRgb(r, g, b, max, delta);
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return [hue, saturation, lightness];
}

function hsvToRgb(hue: number, saturation: number, value: number): Vec3 {
  const h = wrap01(hue) * 6;
  const i = Math.floor(h);
  const f = h - i;
  const p = value * (1 - saturation);
  const q = value * (1 - f * saturation);
  const t = value * (1 - (1 - f) * saturation);

  switch (i % 6) {
    case 0:
      return [value, t, p];
    case 1:
      return [q, value, p];
    case 2:
      return [p, value, t];
    case 3:
      return [p, q, value];
    case 4:
      return [t, p, value];
    default:
      return [value, p, q];
  }
}

function hslToRgb(hue: number, saturation: number, lightness: number): Vec3 {
  const h = wrap01(hue);

  if (saturation <= 1e-9) {
    return [lightness, lightness, lightness];
  }

  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return [
    hueToRgbChannel(p, q, h + 1 / 3),
    hueToRgbChannel(p, q, h),
    hueToRgbChannel(p, q, h - 1 / 3),
  ];
}

function hueToRgbChannel(p: number, q: number, tInput: number) {
  const t = wrap01(tInput);

  if (t < 1 / 6) {
    return p + (q - p) * 6 * t;
  }
  if (t < 1 / 2) {
    return q;
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6;
  }
  return p;
}

function hueFromRgb(r: number, g: number, b: number, max: number, delta: number): number {
  if (delta === 0) {
    return 0;
  }

  let hue = 0;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }

  return (hue * 60 + 360) % 360 / 360;
}

function rgbToHsluv(rgb: Vec3): Vec3 {
  const luv = xyzToLuv(rgbToXyz(rgb));
  const l = luv[0];
  const c = Math.hypot(luv[1], luv[2]);
  const h = c < 1e-8 ? 0 : ((Math.atan2(luv[2], luv[1]) * 180) / Math.PI + 360) % 360;

  if (l > 99.999999 || l < 0.000001 || c < 1e-8) {
    return [h / 360, 0, clamp01(l / 100)];
  }

  const maxChroma = maxChromaForLH(l, h);
  const saturation = maxChroma > 0 ? clamp01(c / maxChroma) : 0;
  return [h / 360, saturation, clamp01(l / 100)];
}

function hsluvToRgb(hue: number, saturation: number, lightness: number): Vec3 {
  const h = wrap01(hue) * 360;
  const l = clamp01(lightness) * 100;
  const c = l > 99.999999 || l < 0.000001 ? 0 : maxChromaForLH(l, h) * clamp01(saturation);
  const hrad = (h / 360) * TAU;
  const luv: Vec3 = [l, Math.cos(hrad) * c, Math.sin(hrad) * c];

  return clampRgb(xyzToRgbUnclamped(luvToXyz(luv)));
}

function luvToXyz([l, u, v]: Vec3): Vec3 {
  if (l <= 0.000001) {
    return [0, 0, 0];
  }

  const uPrime = u / (13 * l) + D65_UV[0];
  const vPrime = v / (13 * l) + D65_UV[1];
  const y = lstarToY(l);

  if (Math.abs(vPrime) < 1e-12) {
    return [0, y, 0];
  }

  const x = (9 * y * uPrime) / (4 * vPrime);
  const z = (9 * y) / vPrime - x - 15 * y;

  return [x, y, z / 3];
}

function xyzToRgbUnclamped([x, y, z]: Vec3): Vec3 {
  const rl = HSLUV_M[0][0] * x + HSLUV_M[0][1] * y + HSLUV_M[0][2] * z;
  const gl = HSLUV_M[1][0] * x + HSLUV_M[1][1] * y + HSLUV_M[1][2] * z;
  const bl = HSLUV_M[2][0] * x + HSLUV_M[2][1] * y + HSLUV_M[2][2] * z;

  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

function maxChromaForLH(l: number, h: number): number {
  const hrad = (h / 360) * TAU;
  let min = Infinity;

  for (const line of getHsluvBounds(l)) {
    const divisor = Math.sin(hrad) - line.slope * Math.cos(hrad);
    if (Math.abs(divisor) < 1e-12) {
      continue;
    }
    const length = line.intercept / divisor;
    if (length >= 0 && Number.isFinite(length)) {
      min = Math.min(min, length);
    }
  }

  return Number.isFinite(min) ? min : 0;
}

function getHsluvBounds(l: number): Array<{ slope: number; intercept: number }> {
  const result: Array<{ slope: number; intercept: number }> = [];
  const sub1 = (l + 16) ** 3 / 1560896;
  const sub2 = sub1 > EPSILON ? sub1 : l / KAPPA;

  for (const row of HSLUV_M) {
    const [m1, m2, m3] = row;
    for (let t = 0; t < 2; t += 1) {
      const top1 = (284517 * m1 - 94839 * m3) * sub2;
      const top2 = (838422 * m3 + 769860 * m2 + 731718 * m1) * l * sub2 - 769860 * t * l;
      const bottom = (632260 * m3 - 126452 * m2) * sub2 + 126452 * t;

      if (Math.abs(bottom) > 1e-12) {
        result.push({ slope: top1 / bottom, intercept: top2 / bottom });
      }
    }
  }

  return result;
}

function yToLstar(y: number): number {
  return y <= EPSILON ? KAPPA * y : 116 * Math.cbrt(y) - 16;
}

function lstarToY(l: number): number {
  return l <= 8 ? l / KAPPA : ((l + 16) / 116) ** 3;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function estimateOccupiedVolume(positions: Float32Array, bounds: Bounds) {
  const gridSize = 36;
  const occupied = new Set<number>();
  const extent = [
    Math.max(bounds.max[0] - bounds.min[0], 1e-9),
    Math.max(bounds.max[1] - bounds.min[1], 1e-9),
    Math.max(bounds.max[2] - bounds.min[2], 1e-9),
  ];

  for (let index = 0; index < positions.length; index += 3) {
    const x = Math.min(gridSize - 1, Math.max(0, Math.floor(((positions[index] - bounds.min[0]) / extent[0]) * gridSize)));
    const y = Math.min(
      gridSize - 1,
      Math.max(0, Math.floor(((positions[index + 1] - bounds.min[1]) / extent[1]) * gridSize)),
    );
    const z = Math.min(
      gridSize - 1,
      Math.max(0, Math.floor(((positions[index + 2] - bounds.min[2]) / extent[2]) * gridSize)),
    );
    occupied.add(x * gridSize * gridSize + y * gridSize + z);
  }

  return (occupied.size / gridSize ** 3) * extent[0] * extent[1] * extent[2];
}

function scaleBounds(bounds: Bounds, scale: number): Bounds {
  return {
    min: [bounds.min[0] * scale, bounds.min[1] * scale, bounds.min[2] * scale],
    max: [bounds.max[0] * scale, bounds.max[1] * scale, bounds.max[2] * scale],
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampRgb([r, g, b]: Vec3): Vec3 {
  return [clamp01(r), clamp01(g), clamp01(b)];
}

function isFiniteRgb([r, g, b]: Vec3) {
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b);
}

function isDisplayableRgb([r, g, b]: Vec3) {
  const tolerance = 0.004;
  return (
    Number.isFinite(r) &&
    Number.isFinite(g) &&
    Number.isFinite(b) &&
    r >= -tolerance &&
    r <= 1 + tolerance &&
    g >= -tolerance &&
    g <= 1 + tolerance &&
    b >= -tolerance &&
    b <= 1 + tolerance
  );
}

function wrap01(value: number) {
  return ((value % 1) + 1) % 1;
}

function sanitizeBounds(bounds: Bounds): Bounds {
  return {
    min: [
      Number.isFinite(bounds.min[0]) ? bounds.min[0] : 0,
      Number.isFinite(bounds.min[1]) ? bounds.min[1] : 0,
      Number.isFinite(bounds.min[2]) ? bounds.min[2] : 0,
    ],
    max: [
      Number.isFinite(bounds.max[0]) ? bounds.max[0] : 1,
      Number.isFinite(bounds.max[1]) ? bounds.max[1] : 1,
      Number.isFinite(bounds.max[2]) ? bounds.max[2] : 1,
    ],
  };
}
