import type { ColorSpaceId } from "./colorSpaces";

interface InfoSource {
  label: string;
  url: string;
}

export interface ColorSpaceInfo {
  title: string;
  overview: string;
  applications: string[];
  slices: string[];
  limits: string[];
  sources: InfoSource[];
}

export const COLOR_SPACE_INFO: Record<ColorSpaceId, ColorSpaceInfo> = {
  srgb: {
    title: "sRGB",
    overview:
      "Standard RGB display space for web and consumer imaging. It is gamma-encoded RGB with fixed primaries, white point, and transfer behavior, so it is useful as a common interchange target.",
    applications: ["Web images and CSS colors", "Default SDR display output", "Consumer cameras, scanners, and simple image exchange"],
    slices: ["R section: fixed red channel", "G section: fixed green channel", "B section: fixed blue channel"],
    limits: ["Smaller gamut than many print or wide-gamut display workflows", "RGB channel steps are not perceptually uniform", "Gamma-encoded values are not ideal for physical light mixing or image processing"],
    sources: [
      { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/SRGB" },
      { label: "ColorWiki", url: "https://www.colorwiki.com/wiki/SRGB" },
    ],
  },
  hsv: {
    title: "HSV",
    overview:
      "A cylindrical rearrangement of RGB intended to make hue and color strength easier to navigate than raw RGB channel values.",
    applications: ["Color pickers", "Quick image-editing controls", "Procedural UI color selection where intuitive hue control matters"],
    slices: ["Value: horizontal section at fixed brightness/value", "Hue: radial vertical section at fixed angle", "Sat: circular shell at fixed radius from the neutral axis"],
    limits: ["Not perceptually uniform; equal steps can look uneven", "Hue becomes unstable near black, white, or gray", "Value is not the same as perceived lightness"],
    sources: [{ label: "Wikipedia", url: "https://en.wikipedia.org/wiki/HSL_and_HSV" }],
  },
  hsl: {
    title: "HSL",
    overview:
      "A cylindrical RGB model using hue, saturation, and lightness. It is designed for familiar tint, shade, and tone style controls rather than measurement accuracy.",
    applications: ["CSS-style color selection", "Design tools and paint-style adjustment controls", "Readable UI controls for hue and lightness"],
    slices: ["Lightness: horizontal section through the lightness axis", "Hue: radial vertical section at fixed angle", "Sat: circular shell at fixed distance from gray"],
    limits: ["Lightness is not perceptual; yellow and blue with the same L can look very different", "Saturation is relative to this RGB geometry, not a physical colorfulness measure", "Poor for contrast prediction and uniform palette generation"],
    sources: [{ label: "Wikipedia", url: "https://en.wikipedia.org/wiki/HSL_and_HSV" }],
  },
  hsluv: {
    title: "HSLuv",
    overview:
      "A human-friendly HSL alternative built from CIELUV/LChuv. Saturation is scaled to the maximum sRGB chroma available for a given hue and lightness.",
    applications: ["More even UI color palettes", "Design systems that need familiar H/S/L controls", "Interactive color selection constrained to sRGB"],
    slices: ["L*: perceptual lightness section", "Hue: vertical section at fixed hue angle", "Sat: gamut-scaled chroma shell for the selected saturation"],
    limits: ["Constrained to the sRGB gamut", "Saturation is a normalized chroma percentage, not classical saturation", "The convenient cylindrical shape still introduces chroma distortion tradeoffs"],
    sources: [
      { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/HSLuv" },
      { label: "HSLuv", url: "https://www.hsluv.org/" },
    ],
  },
  oklab: {
    title: "Oklab",
    overview:
      "A modern perceptual color space with one lightness axis and two opponent color axes. It is designed for more uniform color differences, hue prediction, and smooth color interpolation.",
    applications: ["Perceptual gradients and palette tools", "Lightness-preserving color edits", "Device-independent web colors through CSS Color"],
    slices: ["L: perceived lightness", "a: green to red opponent direction", "b: blue to yellow opponent direction"],
    limits: ["Out-of-sRGB coordinates need gamut clipping or mapping before display", "Still an approximation, not a full color appearance model", "Linear RGB remains preferable for many image-processing operations"],
    sources: [
      { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/Oklab_color_space" },
      { label: "MDN", url: "https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/oklab" },
    ],
  },
  oklch: {
    title: "Oklch",
    overview:
      "The cylindrical form of Oklab. It keeps perceptual lightness, then expresses color strength as chroma and color family as a hue angle.",
    applications: ["CSS color systems and design tokens", "Perceptually smoother shade ramps", "Palette generation with explicit chroma and hue controls"],
    slices: ["L: perceived lightness section", "Hue: vertical radial section at fixed hue angle", "Chroma: circular shell at fixed colorfulness"],
    limits: ["High chroma values can exceed sRGB and require gamut handling", "Hue is undefined when chroma is zero", "Older software may need fallback colors even though modern browser support is broad"],
    sources: [
      { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/Oklab_color_space" },
      { label: "MDN", url: "https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/color_value/oklch" },
    ],
  },
  ycbcr: {
    title: "YCbCr",
    overview:
      "A family of digital video and photography color spaces that separates luma from two chroma-difference channels, usually derived from a related RGB space.",
    applications: ["Digital video pipelines", "JPEG and camera processing", "Compression systems using chroma subsampling"],
    slices: ["Y: luma, the brightness-like encoded channel", "Cb: blue-difference chroma", "Cr: red-difference chroma"],
    limits: ["Y' luma is gamma-encoded and not true physical luminance", "Meaning depends on the underlying RGB primaries, white point, and transfer curve", "Often confused with analog YUV/YPbPr naming"],
    sources: [
      { label: "Wikipedia", url: "https://en.wikipedia.org/wiki/YCbCr" },
      { label: "MultimediaWiki", url: "https://wiki.multimedia.cx/index.php/YCbCr" },
    ],
  },
};
