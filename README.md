# Shape of Colour

Shape of Colour is a browser-based 3D color-space visualizer for inspecting the shape of the displayable sRGB gamut inside different coordinate systems.

The project is designed as a static portfolio piece: all geometry generation, color conversion, interaction, and rendering happen in the browser. No backend is required.

## Features

- Interactive 3D color-volume viewport.
- Exterior gamut shell rendering instead of sparse point clouds.
- Semantic section overlays for inspecting slices through each color space.
- Live 2D section preview with in-gamut boundary indication.
- Readable axis labels and bounding box guides.
- Auto-rotation that pauses when the user manually controls the view.
- Collapsible information panel explaining the selected color space.

## Supported Color Spaces

- sRGB
- HSV
- HSL
- HSLuv
- Oklab
- Oklch
- YCbCr BT.709

CMYK is intentionally omitted because it is four-dimensional and needs a separate slicing model.

## Visualization Model

The app samples the displayable sRGB gamut and maps it into the selected color space. The resulting coordinates are normalized into a stable 3D scene box, then rendered as a colored exterior shell.

This avoids rendering thousands of transparent interior voxels and reduces depth-order artifacts. Hidden/internal faces are not emitted, and the main shell uses front-side rendering with depth writing.

For cylindrical spaces such as HSV, HSL, HSLuv, and Oklch, slice controls use semantic dimensions:

- Height slices: Value, Lightness, L*, or L.
- Hue slices: radial vertical sections at a fixed hue angle.
- Radius slices: Saturation or Chroma shells.

The 3D section overlays are evaluated in a shared fragment shader. Each fragment is converted back to sRGB, discarded when outside the displayable gamut, and edge-highlighted near the gamut boundary.

## Implementation

- React + TypeScript for the UI.
- Three.js and WebGL for the 3D viewport.
- Vite for development and static production builds.
- Canvas rendering for the 2D section preview.
- Browser-side color conversion utilities for sRGB, HSV, HSL, HSLuv, Oklab, Oklch, and YCbCr.

## Local Development

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Build the static site:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## Static Deployment

The built site is emitted to `dist/` and can be deployed to static hosting services such as GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any static file server.

The app does not require a server runtime, database, authentication layer, or API backend.

## Project Notes

See [docs/color-space-visualizer.md](docs/color-space-visualizer.md) for implementation notes, rendering decisions, precision notes, and known limits.
