import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Crop, Eye, EyeOff, Pause, Play, SlidersHorizontal } from "lucide-react";
import { ColorVolumeScene } from "./ColorVolumeScene";
import { COLOR_SPACE_INFO, type ColorSpaceInfo } from "./colorSpaceInfo";
import { recordStage } from "./perfProfiler";
import {
  COLOR_SPACES,
  buildColorSlice,
  buildEmptyColorSlice,
  buildColorVolume,
  getCylindricalHeightLabel,
  getCylindricalRadiusLabel,
  getColorSpaceMeta,
  isCylindricalColorSpace,
  type ColorSpaceId,
  type ColorSliceData,
  type SliceAxis,
  type SliceMode,
} from "./colorSpaces";

const SLICE_RESOLUTION = 384;
const SCRUB_SLICE_RESOLUTION = 128;
const SLICE_STEP = 0.001;
const DEFAULT_PREVIEW_SIZE = 420;
const CYLINDRICAL_SLICE_MODES: Array<{ id: SliceMode; label: "height" | "Hue" | "radius"; title: string }> = [
  { id: "cyl-height", label: "height", title: "Section at a fixed vertical color component" },
  { id: "cyl-hue", label: "Hue", title: "Section at a fixed hue angle" },
  { id: "cyl-saturation", label: "radius", title: "Section at a fixed radial color component" },
];

export function App() {
  const initialSlice = useMemo(readInitialSliceSettings, []);
  const [spaceId, setSpaceId] = useState<ColorSpaceId>("oklab");
  const [autoRotate, setAutoRotate] = useState(true);
  const [showBounds, setShowBounds] = useState(true);
  const [sliceEnabled, setSliceEnabled] = useState(initialSlice.enabled);
  const [sliceAxis, setSliceAxis] = useState<SliceAxis>(initialSlice.axis);
  const [slicePosition, setSlicePosition] = useState(initialSlice.position);
  const [cylindricalSliceMode, setCylindricalSliceMode] = useState<SliceMode>("cyl-height");
  const [previewSize, setPreviewSize] = useState(DEFAULT_PREVIEW_SIZE);
  const [infoOpen, setInfoOpen] = useState(true);
  const [isScrubbingSlice, setIsScrubbingSlice] = useState(false);
  const sliceInputStartRef = useRef<number | null>(null);

  const data = useMemo(() => buildColorVolume({ spaceId }), [spaceId]);

  const meta = getColorSpaceMeta(spaceId);
  const info = COLOR_SPACE_INFO[spaceId];
  const isCylindrical = isCylindricalColorSpace(spaceId);
  const heightLabel = isCylindrical ? getCylindricalHeightLabel(spaceId) : "";
  const radiusLabel = isCylindrical ? getCylindricalRadiusLabel(spaceId) : "";
  const sliceMode: SliceMode = isCylindrical ? cylindricalSliceMode : "component";
  const sliceResolution = isScrubbingSlice ? SCRUB_SLICE_RESOLUTION : SLICE_RESOLUTION;
  const sliceData = useMemo(
    () =>
      sliceEnabled
        ? buildColorSlice(data, sliceAxis, slicePosition, sliceResolution, sliceMode)
        : buildEmptyColorSlice(data, sliceAxis, slicePosition, sliceMode),
    [data, sliceAxis, sliceEnabled, sliceMode, slicePosition, sliceResolution],
  );

  useLayoutEffect(() => {
    if (sliceInputStartRef.current === null) {
      return;
    }

    recordStage("interaction: slider input to React commit", performance.now() - sliceInputStartRef.current);
    sliceInputStartRef.current = null;
  }, [sliceData]);

  const handleSlicePositionChange = (nextPosition: number) => {
    sliceInputStartRef.current = performance.now();
    setSlicePosition(quantizeSlicePosition(nextPosition));
  };

  return (
    <div className="app-shell">
      <aside className="control-panel">
        <header className="brand-block">
          <div className="brand-mark">
            <Box size={20} strokeWidth={2.2} />
          </div>
          <div>
            <p className="eyebrow">3D color gamut</p>
            <h1>Shape of Colour</h1>
          </div>
        </header>

        <section className="panel-section">
          <div className="section-heading">
            <SlidersHorizontal size={16} />
            <span>Space</span>
          </div>
          <div className="space-grid" role="group" aria-label="Color spaces">
            {COLOR_SPACES.map((space) => (
              <button
                className="space-button"
                data-active={space.id === spaceId}
                key={space.id}
                type="button"
                onClick={() => setSpaceId(space.id)}
                aria-pressed={space.id === spaceId}
                title={space.summary}
              >
                {space.label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <span>View</span>
          </div>
          <div className="toggle-row">
            <IconToggle active={autoRotate} label="Rotate" onClick={() => setAutoRotate((value) => !value)}>
              {autoRotate ? <Pause size={16} /> : <Play size={16} />}
            </IconToggle>
            <IconToggle active={showBounds} label="Bounds" onClick={() => setShowBounds((value) => !value)}>
              {showBounds ? <Eye size={16} /> : <EyeOff size={16} />}
            </IconToggle>
          </div>
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <span>Slice</span>
            <IconToggle active={sliceEnabled} label="Section" onClick={() => setSliceEnabled((value) => !value)}>
              <Crop size={16} />
            </IconToggle>
          </div>

          {isCylindrical ? (
            <div className="axis-picker" role="group" aria-label="Cylindrical section mode">
              {CYLINDRICAL_SLICE_MODES.map((mode) => (
                <button
                  className="axis-button"
                  data-active={sliceMode === mode.id}
                  key={mode.id}
                  type="button"
                  aria-pressed={sliceMode === mode.id}
                  onClick={() => setCylindricalSliceMode(mode.id)}
                  title={mode.title}
                >
                  {mode.label === "height" ? heightLabel : mode.label === "radius" ? radiusLabel : mode.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="axis-picker" role="group" aria-label="Slice axis">
              {data.axes.map((axis, index) => (
                <button
                  className="axis-button"
                  data-active={sliceAxis === index}
                  key={axis}
                  type="button"
                  aria-pressed={sliceAxis === index}
                  onClick={() => setSliceAxis(index as SliceAxis)}
                  title={`Slice along ${axis}`}
                >
                  {axis}
                </button>
              ))}
            </div>
          )}

          <RangeControl
            label={sliceData.label.replace(" section", "")}
            max={1}
            min={0}
            step={SLICE_STEP}
            value={slicePosition}
            valueLabel={sliceData.valueLabel}
            onChange={handleSlicePositionChange}
            onScrubEnd={() => setIsScrubbingSlice(false)}
            onScrubStart={() => setIsScrubbingSlice(true)}
          />
        </section>

        <section className="panel-section data-section">
          <div className="section-heading">
            <span>{meta.label}</span>
          </div>
          <p className="space-summary">{meta.summary}</p>
          <dl className="stat-grid">
            <div>
              <dt>Slice</dt>
              <dd>{sliceEnabled ? sliceData.label : "off"}</dd>
            </div>
            {data.axes.map((axis, index) => (
              <div className="axis-stat" key={axis}>
                <dt>{axis}</dt>
                <dd>
                  {formatNumber(data.rawBounds.min[index])} to {formatNumber(data.rawBounds.max[index])}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>

      <main className="stage">
        <ColorVolumeScene
          autoRotate={autoRotate}
          data={data}
          showBounds={showBounds}
          slice={sliceData}
          sliceEnabled={sliceEnabled}
          onUserControlStart={() => setAutoRotate(false)}
        />
        <div className="stage-hud top-left">
          <span>{data.label}</span>
        </div>
        <ColorInfoPanel info={info} open={infoOpen} onToggle={() => setInfoOpen((value) => !value)} />
        {sliceEnabled && <SlicePreview data={sliceData} size={previewSize} onSizeChange={setPreviewSize} />}
      </main>
    </div>
  );
}

interface ColorInfoPanelProps {
  info: ColorSpaceInfo;
  onToggle: () => void;
  open: boolean;
}

function ColorInfoPanel({ info, onToggle, open }: ColorInfoPanelProps) {
  return (
    <aside
      className="color-info-panel"
      data-open={open}
      aria-label={`${info.title} colour space information`}
    >
      <button
        className="color-info-toggle"
        type="button"
        aria-expanded={open}
        aria-label={open ? "Collapse colour space information" : "Expand colour space information"}
        onClick={onToggle}
      >
        i
      </button>
      <div className="color-info-content" aria-hidden={!open}>
        <header>
          <strong>{info.title}</strong>
        </header>
        <p>{info.overview}</p>
        <div className="color-info-grid">
          <InfoList title="Use" items={info.applications} />
          <InfoList title="Slices" items={info.slices} />
          <InfoList title="Limits" items={info.limits} />
        </div>
      </div>
    </aside>
  );
}

function InfoList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

interface RangeControlProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueLabel: string;
  onChange: (value: number) => void;
  onScrubEnd: () => void;
  onScrubStart: () => void;
}

function RangeControl({
  label,
  min,
  max,
  step,
  value,
  valueLabel,
  onChange,
  onScrubEnd,
  onScrubStart,
}: RangeControlProps) {
  return (
    <label className="range-control">
      <span>
        <span>{label}</span>
        <strong>{valueLabel}</strong>
      </span>
      <input
        max={max}
        min={min}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onBlur={onScrubEnd}
        onKeyDown={onScrubStart}
        onKeyUp={onScrubEnd}
        onPointerCancel={onScrubEnd}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
      />
    </label>
  );
}

interface IconToggleProps {
  active: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}

function IconToggle({ active, children, label, onClick }: IconToggleProps) {
  return (
    <button className="icon-toggle" data-active={active} type="button" aria-pressed={active} onClick={onClick} title={label}>
      {children}
      <span>{label}</span>
    </button>
  );
}

interface SlicePreviewProps {
  data: ColorSliceData;
  size: number;
  onSizeChange: (size: number) => void;
}

function SlicePreview({ data, size, onSizeChange }: SlicePreviewProps) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const resizeStateRef = useRef<{ startX: number; startY: number; startSize: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const totalStart = performance.now();
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);
    const outputSize = Math.max(1, Math.round(rect.width * pixelRatio));
    const sourceCanvas = document.createElement("canvas");
    const sourceContext = sourceCanvas.getContext("2d");

    if (!sourceContext) {
      return;
    }

    sourceCanvas.width = data.size;
    sourceCanvas.height = data.size;
    const imageDataStart = performance.now();
    sourceContext.putImageData(new ImageData(data.pixels as ImageDataArray, data.size, data.size), 0, 0);
    recordStage("preview canvas: putImageData", performance.now() - imageDataStart);

    const boundaryStart = performance.now();
    drawInsideMaskBoundary(sourceContext, data.insideMask, data.size);
    recordStage("preview canvas: draw RGB boundary", performance.now() - boundaryStart);

    canvas.width = outputSize;
    canvas.height = outputSize;
    context.clearRect(0, 0, outputSize, outputSize);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const scaleStart = performance.now();
    context.drawImage(sourceCanvas, 0, 0, outputSize, outputSize);
    recordStage("preview canvas: scale drawImage", performance.now() - scaleStart);
    recordStage("preview canvas: total effect", performance.now() - totalStart);
  }, [data, size]);

  const handleResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startSize: size,
    };
  };

  const handleResizeMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = resizeStateRef.current;
    if (!state) {
      return;
    }

    const viewportLimit = Math.max(260, Math.min(window.innerWidth - 32, window.innerHeight - 32));
    const delta = Math.max(state.startX - event.clientX, state.startY - event.clientY);
    onSizeChange(Math.round(Math.min(viewportLimit, Math.max(260, state.startSize + delta))));
  };

  const handleResizeEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvasRect = event.currentTarget.getBoundingClientRect();
    const previewRect = previewRef.current?.getBoundingClientRect();
    if (!previewRect) {
      return;
    }

    const sampleX = Math.floor(((event.clientX - canvasRect.left) / canvasRect.width) * data.size);
    const sampleY = Math.floor(((event.clientY - canvasRect.top) / canvasRect.height) * data.size);

    if (sampleX < 0 || sampleX >= data.size || sampleY < 0 || sampleY >= data.size) {
      setHoverInfo(null);
      return;
    }

    const outsideRgb = data.insideMask[sampleX + sampleY * data.size] === 0;
    if (!outsideRgb) {
      setHoverInfo(null);
      return;
    }

    const tooltipWidth = 150;
    const tooltipHeight = 30;
    setHoverInfo({
      x: Math.min(size - tooltipWidth - 12, Math.max(12, event.clientX - previewRect.left + 12)),
      y: Math.min(size - tooltipHeight - 12, Math.max(12, event.clientY - previewRect.top + 12)),
    });
  };

  return (
    <div className="slice-preview" ref={previewRef} style={{ width: size }}>
      <button
        className="slice-preview-resize"
        type="button"
        aria-label="Resize slice preview"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      <div className="slice-preview-title">
        <span>{data.label}</span>
        <strong>{data.valueLabel}</strong>
      </div>
      <canvas
        ref={canvasRef}
        aria-label="Current 2D slice preview"
        onPointerMove={handleCanvasPointerMove}
        onPointerLeave={() => setHoverInfo(null)}
      />
      {hoverInfo && (
        <div className="slice-preview-tooltip" style={{ left: hoverInfo.x, top: hoverInfo.y }}>
          Outside RGB gamut
        </div>
      )}
      <div className="slice-preview-axes">
        <span>{data.previewAxes[0]}</span>
        <span>{data.previewAxes[1]}</span>
      </div>
    </div>
  );
}

function drawInsideMaskBoundary(context: CanvasRenderingContext2D, mask: Uint8Array, size: number) {
  const image = context.getImageData(0, 0, size, size);
  const data = image.data;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = x + y * size;
      if (!mask[index]) {
        continue;
      }

      const left = x > 0 ? mask[index - 1] : 0;
      const right = x < size - 1 ? mask[index + 1] : 0;
      const top = y > 0 ? mask[index - size] : 0;
      const bottom = y < size - 1 ? mask[index + size] : 0;

      if (left && right && top && bottom) {
        continue;
      }

      const offset = index * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
}

function formatNumber(value: number) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : value;
  const abs = Math.abs(value);
  if (abs >= 100) {
    return rounded.toFixed(1);
  }
  return rounded.toFixed(3);
}

function readInitialSliceSettings() {
  const fallback = {
    enabled: false,
    axis: 2 as SliceAxis,
    position: 0.5,
  };

  if (typeof window === "undefined") {
    return fallback;
  }

  const params = new URLSearchParams(window.location.search);
  const rawAxis = params.get("axis");
  const rawPosition = params.get("pos");
  const axis = rawAxis === null ? NaN : Number(rawAxis);
  const position = rawPosition === null ? NaN : Number(rawPosition);

  return {
    enabled: params.get("slice") === "1",
    axis: axis === 0 || axis === 1 || axis === 2 ? (axis as SliceAxis) : fallback.axis,
    position: Number.isFinite(position) ? quantizeSlicePosition(position) : fallback.position,
  };
}

function quantizeSlicePosition(value: number) {
  return Math.min(1, Math.max(0, Math.round(value / SLICE_STEP) * SLICE_STEP));
}
