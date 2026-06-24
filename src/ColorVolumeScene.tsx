import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Bounds, ColorSliceData, ColorSpaceId, ColorVolumeData, Vec3 } from "./colorSpaces";
import { recordStage } from "./perfProfiler";

interface ReadableTextPlaneData {
  anchorPosition: THREE.Vector3;
  anchorX: number;
  baseX: THREE.Vector3;
  baseY: THREE.Vector3;
  width: number;
}

interface ColorVolumeSceneProps {
  data: ColorVolumeData;
  slice: ColorSliceData;
  sliceEnabled: boolean;
  autoRotate: boolean;
  showBounds: boolean;
  onUserControlStart: () => void;
}

export function ColorVolumeScene({
  data,
  slice,
  sliceEnabled,
  autoRotate,
  showBounds,
  onUserControlStart,
}: ColorVolumeSceneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const volumeGroupRef = useRef<THREE.Group | null>(null);
  const sliceGroupRef = useRef<THREE.Group | null>(null);
  const boundsGroupRef = useRef<THREE.Group | null>(null);
  const userControlStartRef = useRef(onUserControlStart);

  useEffect(() => {
    userControlStartRef.current = onUserControlStart;
  }, [onUserControlStart]);

  useEffect(() => {
    if (controlsRef.current) {
      controlsRef.current.autoRotate = autoRotate;
    }
  }, [autoRotate]);

  useEffect(() => {
    if (boundsGroupRef.current) {
      boundsGroupRef.current.visible = showBounds;
    }
  }, [showBounds]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#000000");

    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    camera.position.set(9, 6.7, 10.8);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor("#000000", 1);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.55;
    controls.target.set(0, -0.7, 0);
    controls.minDistance = 2.2;
    controls.maxDistance = 18;
    const handleControlsStart = () => {
      userControlStartRef.current();
    };
    controls.addEventListener("start", handleControlsStart);

    const volumeGroup = new THREE.Group();
    const sliceGroup = new THREE.Group();
    const boundsGroup = new THREE.Group();
    boundsGroup.visible = showBounds;

    scene.add(volumeGroup, sliceGroup, boundsGroup);

    sceneRef.current = scene;
    rendererRef.current = renderer;
    cameraRef.current = camera;
    controlsRef.current = controls;
    volumeGroupRef.current = volumeGroup;
    sliceGroupRef.current = sliceGroup;
    boundsGroupRef.current = boundsGroup;

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      updateReadableTextPlanes(scene, camera);
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      controls.removeEventListener("start", handleControlsStart);
      controls.dispose();
      clearGroup(volumeGroup);
      clearGroup(sliceGroup);
      clearGroup(boundsGroup);
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      volumeGroupRef.current = null;
      sliceGroupRef.current = null;
      boundsGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const volumeGroup = volumeGroupRef.current;
    const boundsGroup = boundsGroupRef.current;
    if (!volumeGroup || !boundsGroup) {
      return;
    }

    clearGroup(volumeGroup);
    clearGroup(boundsGroup);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(data.surface.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(toLinearVertexColors(data.surface.colors), 3));
    geometry.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      depthTest: true,
      depthWrite: true,
      fog: false,
      side: THREE.FrontSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    volumeGroup.add(mesh);
    boundsGroup.add(createBoundsHelper(data.sceneBounds, data.sceneAxes, data.sceneRawBounds));

    return () => {
      clearGroup(volumeGroup);
      clearGroup(boundsGroup);
    };
  }, [data]);

  useEffect(() => {
    const totalStart = performance.now();
    const sliceGroup = sliceGroupRef.current;
    if (!sliceGroup) {
      return;
    }

    const clearStart = performance.now();
    clearGroup(sliceGroup);
    recordStage("3D slice: clear previous group", performance.now() - clearStart);

    if (!sliceEnabled) {
      recordStage("3D slice: total effect", performance.now() - totalStart);
      return;
    }

    const shaderStart = performance.now();
    sliceGroup.add(createShaderSlice(data, slice));
    recordStage("3D slice: shader section setup", performance.now() - shaderStart);

    recordStage("3D slice: total effect", performance.now() - totalStart);

    return () => {
      clearGroup(sliceGroup);
    };
  }, [data, slice, sliceEnabled]);

  return <div className="viewer-canvas" ref={containerRef} />;
}

const COLOR_SPACE_IDS: Record<ColorSpaceId, number> = {
  srgb: 0,
  hsv: 1,
  hsl: 2,
  hsluv: 3,
  oklab: 4,
  oklch: 5,
  ycbcr: 6,
};

const TAU = Math.PI * 2;

function createShaderSlice(data: ColorVolumeData, slice: ColorSliceData) {
  const geometry = createShaderSliceGeometry(data, slice);

  if (slice.mode === "cyl-saturation") {
    return createLayeredRadiusSlice(data, geometry);
  }

  const material = createShaderSliceMaterial(data, THREE.DoubleSide, true);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

function createLayeredRadiusSlice(data: ColorVolumeData, geometry: THREE.BufferGeometry) {
  const group = new THREE.Group();
  const backMesh = new THREE.Mesh(geometry, createShaderSliceMaterial(data, THREE.BackSide, false));
  const frontMesh = new THREE.Mesh(geometry.clone(), createShaderSliceMaterial(data, THREE.FrontSide, false));

  backMesh.frustumCulled = false;
  frontMesh.frustumCulled = false;
  backMesh.renderOrder = 1;
  frontMesh.renderOrder = 1.01;
  group.add(backMesh, frontMesh);
  return group;
}

function createShaderSliceMaterial(data: ColorVolumeData, side: THREE.Side, transparent: boolean) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSpaceId: { value: COLOR_SPACE_IDS[data.id] },
      uGamutTolerance: { value: 0.004 },
    },
    vertexShader: SHADER_SLICE_VERTEX,
    fragmentShader: SHADER_SLICE_FRAGMENT,
    transparent,
    depthTest: false,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side,
  });
  (material.extensions as unknown as { derivatives?: boolean }).derivatives = true;
  return material;
}

function createShaderSliceGeometry(data: ColorVolumeData, slice: ColorSliceData) {
  if (slice.mode === "cyl-height") {
    return createHeightSliceGeometry(data, slice);
  }

  if (slice.mode === "cyl-hue") {
    return createHueSliceGeometry(data, slice);
  }

  if (slice.mode === "cyl-saturation") {
    return createRadiusSliceGeometry(data, slice);
  }

  return createComponentSliceGeometry(data, slice);
}

function createComponentSliceGeometry(data: ColorVolumeData, slice: ColorSliceData) {
  const axis = slice.axis;
  const [uAxis, vAxis] = slice.axes2D;
  const min = data.rawBounds.min;
  const max = data.rawBounds.max;
  const plane = min[axis] + slice.position * (max[axis] - min[axis]);
  const rawCorners = [
    pointFromRawAxes(axis, uAxis, vAxis, plane, min[uAxis], min[vAxis]),
    pointFromRawAxes(axis, uAxis, vAxis, plane, max[uAxis], min[vAxis]),
    pointFromRawAxes(axis, uAxis, vAxis, plane, max[uAxis], max[vAxis]),
    pointFromRawAxes(axis, uAxis, vAxis, plane, min[uAxis], max[vAxis]),
  ];

  return createRawQuadGeometry(data, rawCorners);
}

function createHeightSliceGeometry(data: ColorVolumeData, slice: ColorSliceData) {
  const z = data.rawBounds.min[2] + slice.position * (data.rawBounds.max[2] - data.rawBounds.min[2]);
  const xMin = data.id === "oklch" ? data.rawBounds.min[0] : -1;
  const xMax = data.id === "oklch" ? data.rawBounds.max[0] : 1;
  const yMin = data.id === "oklch" ? data.rawBounds.min[1] : -1;
  const yMax = data.id === "oklch" ? data.rawBounds.max[1] : 1;

  return createRawQuadGeometry(data, [
    [xMin, yMin, z],
    [xMax, yMin, z],
    [xMax, yMax, z],
    [xMin, yMax, z],
  ]);
}

function createHueSliceGeometry(data: ColorVolumeData, slice: ColorSliceData) {
  const radius = data.id === "oklch" ? data.polarRadiusMax : 1;
  const zMin = data.rawBounds.min[2];
  const zMax = data.rawBounds.max[2];
  const angle = slice.position * TAU;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;

  return createRawQuadGeometry(data, [
    [0, 0, zMin],
    [x, y, zMin],
    [x, y, zMax],
    [0, 0, zMax],
  ]);
}

function createRadiusSliceGeometry(data: ColorVolumeData, slice: ColorSliceData) {
  const radius = data.id === "oklch" ? slice.position * data.polarRadiusMax : slice.position;
  const zMin = data.rawBounds.min[2];
  const zMax = data.rawBounds.max[2];
  const segments = 160;
  const positions: number[] = [];
  const rawPositions: number[] = [];
  const indices: number[] = [];
  // The radial cylinder's base triangulation points inward in raw cylindrical space.
  // Flip it only when the scene-axis permutation has not already flipped handedness.
  const reverseWinding = !isOddAxisOrder(data.sceneToRawAxes);

  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * TAU;
    const rawBottom: Vec3 = [Math.cos(angle) * radius, Math.sin(angle) * radius, zMin];
    const rawTop: Vec3 = [rawBottom[0], rawBottom[1], zMax];
    const bottom = rawToScenePoint(data, rawBottom);
    const top = rawToScenePoint(data, rawTop);
    positions.push(bottom.x, bottom.y, bottom.z, top.x, top.y, top.z);
    rawPositions.push(rawBottom[0], rawBottom[1], rawBottom[2], rawTop[0], rawTop[1], rawTop[2]);
  }

  for (let index = 0; index < segments; index += 1) {
    const offset = index * 2;
    pushTriangle(indices, offset, offset + 1, offset + 3, reverseWinding);
    pushTriangle(indices, offset, offset + 3, offset + 2, reverseWinding);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("rawPoint", new THREE.Float32BufferAttribute(rawPositions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function pushTriangle(indices: number[], a: number, b: number, c: number, reverse: boolean) {
  if (reverse) {
    indices.push(a, c, b);
    return;
  }

  indices.push(a, b, c);
}

function isOddAxisOrder(order: readonly [number, number, number]) {
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

function createRawQuadGeometry(data: ColorVolumeData, rawCorners: Vec3[]) {
  const positions: number[] = [];
  const rawPositions: number[] = [];

  for (const rawPoint of rawCorners) {
    const point = rawToScenePoint(data, rawPoint);
    positions.push(point.x, point.y, point.z);
    rawPositions.push(rawPoint[0], rawPoint[1], rawPoint[2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("rawPoint", new THREE.Float32BufferAttribute(rawPositions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeBoundingSphere();
  return geometry;
}

function pointFromRawAxes(axis: number, uAxis: number, vAxis: number, plane: number, u: number, v: number): Vec3 {
  const point: Vec3 = [0, 0, 0];
  point[axis] = plane;
  point[uAxis] = u;
  point[vAxis] = v;
  return point;
}

function rawToScenePoint(data: ColorVolumeData, rawPoint: Vec3) {
  const center = [
    (data.rawBounds.min[0] + data.rawBounds.max[0]) * 0.5,
    (data.rawBounds.min[1] + data.rawBounds.max[1]) * 0.5,
    (data.rawBounds.min[2] + data.rawBounds.max[2]) * 0.5,
  ];
  const normalizedRaw: Vec3 = [
    ((rawPoint[0] - center[0]) / data.maxExtent) * 2 * data.sceneScale,
    ((rawPoint[1] - center[1]) / data.maxExtent) * 2 * data.sceneScale,
    ((rawPoint[2] - center[2]) / data.maxExtent) * 2 * data.sceneScale,
  ];

  return new THREE.Vector3(
    normalizedRaw[data.sceneToRawAxes[0]],
    normalizedRaw[data.sceneToRawAxes[1]],
    normalizedRaw[data.sceneToRawAxes[2]],
  );
}

const SHADER_SLICE_VERTEX = `
  attribute vec3 rawPoint;
  varying vec3 vRawPoint;

  void main() {
    vRawPoint = rawPoint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHADER_SLICE_FRAGMENT = `
  precision highp float;

  uniform int uSpaceId;
  uniform float uGamutTolerance;
  varying vec3 vRawPoint;

  const float PI = 3.141592653589793;
  const float TAU = 6.283185307179586;
  const float EPSILON = 0.008856451679035631;
  const float KAPPA = 903.2962962962963;
  const vec2 D65_UV = vec2(0.19783982482140777, 0.46833630293240974);

  float wrap01(float value) {
    return fract(value);
  }

  float linearToSrgbChannel(float value) {
    return value <= 0.0031308 ? 12.92 * value : 1.055 * pow(max(value, 0.0), 1.0 / 2.4) - 0.055;
  }

  vec3 linearToSrgb(vec3 value) {
    return vec3(
      linearToSrgbChannel(value.r),
      linearToSrgbChannel(value.g),
      linearToSrgbChannel(value.b)
    );
  }

  float srgbToLinearChannel(float value) {
    return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4);
  }

  vec3 srgbToLinear(vec3 value) {
    return vec3(
      srgbToLinearChannel(value.r),
      srgbToLinearChannel(value.g),
      srgbToLinearChannel(value.b)
    );
  }

  vec3 hsvToRgb(float hue, float saturation, float value) {
    float h = wrap01(hue) * 6.0;
    float i = floor(h);
    float f = h - i;
    float p = value * (1.0 - saturation);
    float q = value * (1.0 - f * saturation);
    float t = value * (1.0 - (1.0 - f) * saturation);
    float m = mod(i, 6.0);

    if (m < 0.5) return vec3(value, t, p);
    if (m < 1.5) return vec3(q, value, p);
    if (m < 2.5) return vec3(p, value, t);
    if (m < 3.5) return vec3(p, q, value);
    if (m < 4.5) return vec3(t, p, value);
    return vec3(value, p, q);
  }

  float hueToRgbChannel(float p, float q, float tInput) {
    float t = wrap01(tInput);
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
  }

  vec3 hslToRgb(float hue, float saturation, float lightness) {
    float h = wrap01(hue);
    if (saturation <= 1e-9) return vec3(lightness);
    float q = lightness < 0.5 ? lightness * (1.0 + saturation) : lightness + saturation - lightness * saturation;
    float p = 2.0 * lightness - q;
    return vec3(
      hueToRgbChannel(p, q, h + 1.0 / 3.0),
      hueToRgbChannel(p, q, h),
      hueToRgbChannel(p, q, h - 1.0 / 3.0)
    );
  }

  float yToLstar(float y) {
    return y <= EPSILON ? KAPPA * y : 116.0 * pow(y, 1.0 / 3.0) - 16.0;
  }

  float lstarToY(float l) {
    return l <= 8.0 ? l / KAPPA : pow((l + 16.0) / 116.0, 3.0);
  }

  vec3 luvToXyz(vec3 luv) {
    float l = luv.x;
    if (l <= 0.000001) return vec3(0.0);
    float uPrime = luv.y / (13.0 * l) + D65_UV.x;
    float vPrime = luv.z / (13.0 * l) + D65_UV.y;
    float y = lstarToY(l);
    if (abs(vPrime) < 1e-12) return vec3(0.0, y, 0.0);
    float x = (9.0 * y * uPrime) / (4.0 * vPrime);
    float z = (9.0 * y) / vPrime - x - 15.0 * y;
    return vec3(x, y, z / 3.0);
  }

  vec3 xyzToRgbUnclamped(vec3 xyz) {
    vec3 linearRgb = vec3(
      3.240969941904521 * xyz.x - 1.537383177570093 * xyz.y - 0.498610760293 * xyz.z,
     -0.96924363628087 * xyz.x + 1.87596750150772 * xyz.y + 0.041555057407175 * xyz.z,
      0.055630079696993 * xyz.x - 0.20397695888897 * xyz.y + 1.056971514242878 * xyz.z
    );
    return linearToSrgb(linearRgb);
  }

  vec3 hsluvRow(int index) {
    if (index == 0) return vec3(3.240969941904521, -1.537383177570093, -0.498610760293);
    if (index == 1) return vec3(-0.96924363628087, 1.87596750150772, 0.041555057407175);
    return vec3(0.055630079696993, -0.20397695888897, 1.056971514242878);
  }

  float maxChromaForLH(float l, float h) {
    float hrad = (h / 360.0) * TAU;
    float minValue = 1e20;
    float sub1 = pow(l + 16.0, 3.0) / 1560896.0;
    float sub2 = sub1 > EPSILON ? sub1 : l / KAPPA;

    for (int i = 0; i < 3; i += 1) {
      vec3 row = hsluvRow(i);
      for (int t = 0; t < 2; t += 1) {
        float tf = float(t);
        float top1 = (284517.0 * row.x - 94839.0 * row.z) * sub2;
        float top2 = (838422.0 * row.z + 769860.0 * row.y + 731718.0 * row.x) * l * sub2 - 769860.0 * tf * l;
        float bottom = (632260.0 * row.z - 126452.0 * row.y) * sub2 + 126452.0 * tf;

        if (abs(bottom) > 1e-12) {
          float divisor = sin(hrad) - (top1 / bottom) * cos(hrad);
          if (abs(divisor) > 1e-12) {
            float lengthValue = (top2 / bottom) / divisor;
            if (lengthValue >= 0.0) {
              minValue = min(minValue, lengthValue);
            }
          }
        }
      }
    }

    return minValue < 1e19 ? minValue : 0.0;
  }

  vec3 hsluvToRgb(float hue, float saturation, float lightness) {
    float h = wrap01(hue) * 360.0;
    float l = clamp(lightness, 0.0, 1.0) * 100.0;
    float c = (l > 99.999999 || l < 0.000001) ? 0.0 : maxChromaForLH(l, h) * clamp(saturation, 0.0, 1.0);
    float hrad = (h / 360.0) * TAU;
    return clamp(xyzToRgbUnclamped(luvToXyz(vec3(l, cos(hrad) * c, sin(hrad) * c))), 0.0, 1.0);
  }

  vec3 oklabToRgb(vec3 lab) {
    float lRoot = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
    float mRoot = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
    float sRoot = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
    float lmsL = lRoot * lRoot * lRoot;
    float lmsM = mRoot * mRoot * mRoot;
    float lmsS = sRoot * sRoot * sRoot;
    return linearToSrgb(vec3(
      4.0767416621 * lmsL - 3.3077115913 * lmsM + 0.2309699292 * lmsS,
     -1.2684380046 * lmsL + 2.6097574011 * lmsM - 0.3413193965 * lmsS,
     -0.0041960863 * lmsL - 0.7034186147 * lmsM + 1.7076147010 * lmsS
    ));
  }

  vec3 ycbcr709ToRgb(vec3 ycbcr) {
    float kr = 0.2126;
    float kb = 0.0722;
    float kg = 1.0 - kr - kb;
    float chromaB = ycbcr.y - 0.5;
    float chromaR = ycbcr.z - 0.5;
    float r = ycbcr.x + 2.0 * (1.0 - kr) * chromaR;
    float b = ycbcr.x + 2.0 * (1.0 - kb) * chromaB;
    float g = (ycbcr.x - kr * r - kb * b) / kg;
    return vec3(r, g, b);
  }

  vec4 rawRgbFromPoint(vec3 point) {
    if (uSpaceId == 0) {
      return vec4(point, 1.0);
    }

    if (uSpaceId == 1 || uSpaceId == 2 || uSpaceId == 3) {
      float radius = length(point.xy);
      if (radius > 1.000001 || point.z < -0.000001 || point.z > 1.000001) {
        return vec4(0.0);
      }
      float hue = radius <= 1e-8 ? 0.0 : wrap01(atan(point.y, point.x) / TAU);
      if (uSpaceId == 1) return vec4(hsvToRgb(hue, clamp(radius, 0.0, 1.0), clamp(point.z, 0.0, 1.0)), 1.0);
      if (uSpaceId == 2) return vec4(hslToRgb(hue, clamp(radius, 0.0, 1.0), clamp(point.z, 0.0, 1.0)), 1.0);
      return vec4(hsluvToRgb(hue, clamp(radius, 0.0, 1.0), clamp(point.z, 0.0, 1.0)), 1.0);
    }

    if (uSpaceId == 4) {
      return vec4(oklabToRgb(point), 1.0);
    }

    if (uSpaceId == 5) {
      return vec4(oklabToRgb(vec3(point.z, point.x, point.y)), 1.0);
    }

    return vec4(ycbcr709ToRgb(point), 1.0);
  }

  bool displayableRgb(vec3 rgb) {
    return
      rgb.r >= -uGamutTolerance && rgb.r <= 1.0 + uGamutTolerance &&
      rgb.g >= -uGamutTolerance && rgb.g <= 1.0 + uGamutTolerance &&
      rgb.b >= -uGamutTolerance && rgb.b <= 1.0 + uGamutTolerance;
  }

  float insideValue(vec3 rawPoint) {
    vec4 sampleValue = rawRgbFromPoint(rawPoint);
    return sampleValue.a > 0.5 && displayableRgb(sampleValue.rgb) ? 1.0 : 0.0;
  }

  void main() {
    vec4 sampleValue = rawRgbFromPoint(vRawPoint);
    if (sampleValue.a < 0.5 || !displayableRgb(sampleValue.rgb)) {
      discard;
    }

    vec3 rawDx = dFdx(vRawPoint) * 1.45;
    vec3 rawDy = dFdy(vRawPoint) * 1.45;
    float edge =
      (1.0 - insideValue(vRawPoint + rawDx)) +
      (1.0 - insideValue(vRawPoint - rawDx)) +
      (1.0 - insideValue(vRawPoint + rawDy)) +
      (1.0 - insideValue(vRawPoint - rawDy));

    vec3 linearRgb = srgbToLinear(clamp(sampleValue.rgb, 0.0, 1.0));
    linearRgb = mix(linearRgb, vec3(1.0), clamp(edge, 0.0, 1.0) * 0.78);
    gl_FragColor = vec4(linearRgb, 0.98);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function createBoundsHelper(bounds: Bounds, axes: readonly [string, string, string], rawBounds: Bounds): THREE.Group {
  const group = new THREE.Group();
  const size = new THREE.Vector3(
    Math.max(bounds.max[0] - bounds.min[0], 0.01),
    Math.max(bounds.max[1] - bounds.min[1], 0.01),
    Math.max(bounds.max[2] - bounds.min[2], 0.01),
  );
  const center = new THREE.Vector3(
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  );
  const box = new THREE.BoxGeometry(size.x, size.y, size.z);
  const edges = new THREE.EdgesGeometry(box);
  const material = new THREE.LineBasicMaterial({
    color: "#f4f0dc",
    transparent: true,
    opacity: 0.58,
  });
  const helper = new THREE.LineSegments(edges, material);
  helper.position.copy(center);
  group.add(helper);
  addBoundsLabels(group, bounds, axes, rawBounds);
  box.dispose();
  return group;
}

function addBoundsLabels(
  group: THREE.Group,
  bounds: Bounds,
  axes: readonly [string, string, string],
  rawBounds: Bounds,
) {
  const offset = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    1,
  ) * 0.11;
  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const labels: Array<{
    anchorX: number;
    planeX: THREE.Vector3;
    planeY: THREE.Vector3;
    position: THREE.Vector3;
    text: string;
  }> = [
    {
      text: `${axes[0]} - ${formatBound(rawBounds.min[0])}`,
      position: new THREE.Vector3(bounds.min[0], bounds.min[1] - offset, bounds.min[2] - offset),
      anchorX: 1,
      planeX: xAxis,
      planeY: zAxis,
    },
    {
      text: `${axes[0]} + ${formatBound(rawBounds.max[0])}`,
      position: new THREE.Vector3(bounds.max[0], bounds.min[1] - offset, bounds.min[2] - offset),
      anchorX: 0,
      planeX: xAxis,
      planeY: zAxis,
    },
    {
      text: `${axes[1]} - ${formatBound(rawBounds.min[1])}`,
      position: new THREE.Vector3(bounds.min[0] - offset, bounds.min[1], bounds.min[2] - offset),
      anchorX: 1,
      planeX: yAxis,
      planeY: xAxis,
    },
    {
      text: `${axes[1]} + ${formatBound(rawBounds.max[1])}`,
      position: new THREE.Vector3(bounds.min[0] - offset, bounds.max[1], bounds.min[2] - offset),
      anchorX: 0,
      planeX: yAxis,
      planeY: xAxis,
    },
    {
      text: `${axes[2]} - ${formatBound(rawBounds.min[2])}`,
      position: new THREE.Vector3(bounds.min[0] - offset, bounds.min[1] - offset, bounds.min[2]),
      anchorX: 1,
      planeX: zAxis,
      planeY: yAxis,
    },
    {
      text: `${axes[2]} + ${formatBound(rawBounds.max[2])}`,
      position: new THREE.Vector3(bounds.min[0] - offset, bounds.min[1] - offset, bounds.max[2]),
      anchorX: 0,
      planeX: zAxis,
      planeY: yAxis,
    },
  ];

  for (const entry of labels) {
    group.add(createTextPlane(entry.text, entry.position, entry.planeX, entry.planeY, entry.anchorX));
  }
}

function createTextPlane(
  text: string,
  position: THREE.Vector3,
  planeX: THREE.Vector3,
  planeY: THREE.Vector3,
  anchorX = 0.5,
  textHeight = 0.22,
) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const label = text.toUpperCase();
  const fontSize = 42;
  const paddingX = 18;
  const paddingY = 10;
  const font = `700 ${fontSize}px Arial Narrow, Arial, sans-serif`;

  if (!context) {
    return new THREE.Group();
  }

  context.font = font;
  const width = context.measureText(label).width;
  canvas.width = Math.ceil(width + paddingX * 2);
  canvas.height = fontSize + paddingY * 2;
  context.font = font;
  context.textAlign = "left";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(0, 0, 0, 0.9)";
  context.lineWidth = 8;
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.strokeText(label, paddingX, canvas.height / 2 + 1);
  context.fillText(label, paddingX, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const textWidth = (canvas.width / canvas.height) * textHeight;
  const geometry = new THREE.PlaneGeometry(textWidth, textHeight);
  const mesh = new THREE.Mesh(geometry, material);
  const x = planeX.clone().normalize();
  const y = planeY.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  const matrix = new THREE.Matrix4().makeBasis(x, y, z);
  const anchorOffset = x.clone().multiplyScalar((0.5 - anchorX) * textWidth);

  mesh.quaternion.setFromRotationMatrix(matrix);
  mesh.position.copy(position).add(anchorOffset);
  mesh.userData.readableText = {
    anchorPosition: position.clone(),
    anchorX,
    baseX: x,
    baseY: y,
    width: textWidth,
  } satisfies ReadableTextPlaneData;
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return mesh;
}

function updateReadableTextPlanes(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
  const matrix = new THREE.Matrix4();

  scene.traverse((object) => {
    const readableText = object.userData.readableText as ReadableTextPlaneData | undefined;

    if (!readableText) {
      return;
    }

    const mesh = object as THREE.Mesh;
    const toCamera = cameraPosition.clone().sub(readableText.anchorPosition).normalize();
    let bestX = readableText.baseX;
    let bestY = readableText.baseY;
    let bestNormal = new THREE.Vector3().crossVectors(bestX, bestY).normalize();
    let bestScore = -Infinity;

    const basisPairs = [
      [readableText.baseX, readableText.baseY],
      [readableText.baseY, readableText.baseX],
    ];

    for (const [basisX, basisY] of basisPairs) {
      for (const xSign of [-1, 1]) {
        for (const ySign of [-1, 1]) {
          const candidateX = basisX.clone().multiplyScalar(xSign);
          const candidateY = basisY.clone().multiplyScalar(ySign);
          const candidateNormal = new THREE.Vector3().crossVectors(candidateX, candidateY).normalize();
          const score =
            candidateNormal.dot(toCamera) * 5 +
            candidateX.dot(cameraRight) * 2 +
            candidateY.dot(cameraUp) * 2;

          if (score > bestScore) {
            bestScore = score;
            bestX = candidateX;
            bestY = candidateY;
            bestNormal = candidateNormal;
          }
        }
      }
    }

    matrix.makeBasis(bestX, bestY, bestNormal);
    mesh.quaternion.setFromRotationMatrix(matrix);
    mesh.position
      .copy(readableText.anchorPosition)
      .add(bestX.clone().multiplyScalar((0.5 - readableText.anchorX) * readableText.width));
  });
}

function formatBound(value: number) {
  const abs = Math.abs(value);
  if (abs >= 100) {
    return value.toFixed(1);
  }
  if (abs >= 1) {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

function toLinearVertexColors(colors: Float32Array) {
  const linear = new Float32Array(colors.length);
  const color = new THREE.Color();

  for (let index = 0; index < colors.length; index += 3) {
    color.setRGB(colors[index], colors[index + 1], colors[index + 2], THREE.SRGBColorSpace);
    linear[index] = color.r;
    linear[index + 1] = color.g;
    linear[index + 2] = color.b;
  }

  return linear;
}

function clearGroup(group: THREE.Group) {
  const children = [...group.children];
  for (const child of children) {
    group.remove(child);
    disposeObject(child);
  }
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: THREE.Material) {
  const maybeWithMap = material as THREE.Material & { map?: THREE.Texture };
  if (maybeWithMap.map) {
    maybeWithMap.map.dispose();
  }
  material.dispose();
}
