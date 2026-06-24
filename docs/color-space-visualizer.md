# 3D Color Space Visualizer

## Goal

Build a web-based 3D viewport for inspecting multiple color spaces as continuous color volumes, not as sparse point clouds. The first implementation focuses on accurate browser-side visualization of displayable colors by mapping the sRGB gamut into each selected coordinate system.

Supported spaces:

- sRGB
- HSV
- HSL
- HSLuv
- Oklab `L, a, b`
- Oklch `L, C, h`
- YCbCr BT.709

## Visualization Model

The viewport renders an exterior surface mesh derived from dense color-space sampling:

1. Generate a regular 3D sample grid in a source color domain.
2. Convert every sample to display sRGB for color and to the selected space for position.
3. Normalize target coordinates into a stable scene box, then apply an estimated-volume scale so sparse gamuts do not appear visually tiny next to space-filling cubes.
4. Generate only the visible exterior shell faces.
5. Render the shell as a vertex-colored `THREE.BufferGeometry`.

This keeps the visual weight of a solid body while avoiding the depth-sorting artifacts caused by thousands of transparent interior voxels. Internal faces are not emitted, and the material uses front-side rendering with depth writing so back-facing and hidden surfaces do not float through the foreground.

## Coordinate Strategy

Most spaces are visualized as the displayable sRGB gamut transformed into the target coordinate system. This answers the practical question: "What shape do colors my monitor can show occupy in this space?"

For cylindrical spaces:

- HSV uses polar hue for `x/y` and value for `z`.
- HSL uses polar hue for `x/y` and lightness for `z`.
- HSLuv uses polar hue for `x/y` and perceptual lightness for `z`.
- HSV, HSL, and HSLuv use their own cylindrical surface parameterization instead of projecting all sRGB cube faces, because those spaces are not one-to-one with RGB.
- The cylindrical spaces include both top and bottom caps. HSV's bottom cap is black at `V = 0`; HSL and HSLuv include black bottom caps and white top caps at their lightness extremes.
- Oklch is embedded as `cos(h) * C`, `sin(h) * C`, and `L`.
- Cylindrical section controls are semantic. HSV exposes `Value`, `Hue`, and `Sat`; HSL exposes `Lightness`, `Hue`, and `Sat`; HSLuv exposes `L*`, `Hue`, and `Sat`; Oklch exposes `L`, `Hue`, and `Chroma`.
- These sections render as floating shader overlay planes or cylindrical/radial sheets. The shell is no longer cut open; the section shader evaluates the inverse color-space mapping, discards out-of-gamut fragments, and brightens the sampled edge.

## Precision Notes

- sRGB values are decoded to linear RGB before XYZ/Oklab/Oklch/HSLuv conversion.
- XYZ conversion uses the standard D65 sRGB matrix.
- CIELUV uses the D65 reference white.
- Oklab uses the Bjorn Ottosson matrix chain from linear sRGB to LMS to Lab.
- Oklch is derived from Oklab with polar chroma and hue.
- YCbCr uses normalized BT.709 coefficients.
- JavaScript numbers are double precision, so conversion math is not quantized before GPU upload.

The visualizer is still a sampled approximation, but the user-facing sampling controls are intentionally hidden now that the app is focused on the exterior gamut surface plus semantic section overlays.

## Rendering Controls

The first UI includes:

- Color space selector.
- Toggles for autorotation and gamut bounds.
- Semantic section controls. Cartesian spaces use their three named coordinates; cylindrical spaces use height, hue, and radial sections.
- A live 2D section preview rendered to canvas. It is anchored to the bottom-right corner and can be resized from its upper-left handle while keeping a square image area.

Autorotation pauses as soon as the user manually drags, pans, or zooms the 3D viewport.

When bounds are enabled, the bounding box uses direct in-space text for the negative and positive coordinate directions of each displayed axis. These labels are fixed to orthogonal grid planes rather than billboarding to the camera, but their in-plane orientation flips by camera quadrant so the English text stays readable.

## Performance Budget

The internal surface sample count is fixed for the current UI. Rendered geometry is an exterior shell, so displayed face count grows closer to `resolution^2` internally even though the source sample grid is cubic.

The renderer uses `THREE.BufferGeometry` with per-vertex colors. Most spaces emit the six transformed sRGB gamut boundary faces; HSV/HSL/HSLuv emit native cylindrical shell faces.

3D sections are generated as independent overlay meshes rather than WebGL clipping planes. Cartesian spaces use one quad in the selected raw coordinate plane; cylindrical spaces use semantic overlay geometry for height, hue angle, and radial components. A shared fragment shader converts each raw point back to sRGB, discards fragments outside the displayable gamut, and uses derivative samples around the fragment to brighten the visible gamut boundary.

The 2D section preview prioritizes the geometry of the 3D section. Height slices in cylindrical spaces are drawn as their embedded circular/polar section rather than forced into a rectangular hue-saturation parameter chart. Values outside the displayable sRGB gamut are colored only when the extension has a meaningful inverse-space interpretation; those colors are produced by evaluating the inverse conversion and clamping to the nearest displayable RGB approximation. A white boundary marks the in-gamut sRGB region, and hovering outside that boundary shows an out-of-gamut hint.

## Known Limits

- The display color is constrained to sRGB output, so colors outside the monitor gamut cannot be shown directly.
- Out-of-gamut 2D preview colors are approximations produced by clamping extrapolated RGB values.
- HSLuv conversion is implemented for visualization and follows the public HSLuv math, but the rendered volume is still bound by sampling density.
- CMYK is intentionally omitted from the current UI because it is four-dimensional and needs a separate design for meaningful slicing.
- YCbCr is shown with BT.709 coefficients; other standards such as BT.601 or BT.2020 would produce slightly different coordinates.

## Implementation Plan

1. Create a Vite React app with Three.js.
2. Implement color conversion utilities in TypeScript.
3. Build a reusable `ColorVolumeScene` component that owns the Three.js renderer, camera, orbit controls, bounds labels, semantic section overlays, and color-space shell mesh.
4. Build a compact control panel for selecting spaces and semantic section settings.
5. Verify with a production build and a browser smoke test.
