"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import type { PressGraphic } from "@/server/db/schema";
import { saveGraphicAction } from "./actions";

const W = 1080;
const SIZES: Record<PressGraphic["size"], [number, string]> = { square: [1080, "Square, 1080 x 1080"], portrait: [1350, "Portrait, 1080 x 1350"],
  story: [1920, "Story, 1080 x 1920"] };
const LAYOUTS: Record<PressGraphic["layout"], string> = { wash: "Photo with a wash", split: "Photo and panel", bands: "Bands", type: "No photo" };

// The app's own faces, loaded from Adobe Fonts by the page. Each has a named fallback.
const FACE = {
  head: (px: number) => `900 ${px}px "ff-good-web-pro-compressed", Impact, "Arial Narrow", sans-serif`,
  label: (px: number) => `500 ${px}px "ff-good-web-pro", "Helvetica Neue", Arial, sans-serif`,
  quote: (px: number) => `italic 400 ${px}px adelle, Georgia, serif`,
};
const NEEDED: [string, string, string][] = [[FACE.head(40), "Good Pro Compressed", "Impact"], [FACE.label(40), "Good Pro", "Helvetica"],
  [FACE.quote(40), "Adelle", "Georgia"]];

type Ctx = CanvasRenderingContext2D;
type Fit = { px: number; lines: string[]; height: number };

function wrap(c: Ctx, text: string, max: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && c.measureText(next).width > max) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

// The largest size at which the text fits the measure in the lines allowed.
function fit(c: Ctx, text: string, face: (px: number) => string, o: { width: number; lines: number; max: number; min: number; pitch: number }): Fit {
  for (let px = o.max; px >= o.min; px -= 2) {
    c.font = face(px);
    const lines = wrap(c, text, o.width);
    if (lines.length <= o.lines && lines.every((l) => c.measureText(l).width <= o.width)) return { px, lines, height: lines.length * px * o.pitch };
  }
  c.font = face(o.min);
  const lines = wrap(c, text, o.width).slice(0, o.lines);
  return { px: o.min, lines, height: lines.length * o.min * o.pitch };
}

function write(c: Ctx, f: Fit, face: (px: number) => string, x: number, top: number, pitch: number, align: CanvasTextAlign) {
  c.font = face(f.px);
  c.textAlign = align;
  c.textBaseline = "alphabetic";
  f.lines.forEach((l, i) => c.fillText(l, x, top + f.px * 0.82 + i * f.px * pitch));
}

function cover(c: Ctx, img: HTMLImageElement | null, x: number, y: number, w: number, h: number, fx: number, fy: number, empty: string) {
  if (!img) {
    c.fillStyle = empty;
    c.fillRect(x, y, w, h);
    return;
  }
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / scale;
  const sh = h / scale;
  c.drawImage(img, (img.naturalWidth - sw) * fx, (img.naturalHeight - sh) * fy, sw, sh, x, y, w, h);
}

const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

type Photo = { img: HTMLImageElement | null; x: number; y: number };

// Name and office line, then the headline and the statement between two hairlines, set as one block.
function panel(c: Ctx, g: PressGraphic, box: { x: number; y: number; w: number; h: number }) {
  const [name, ...office] = g.kicker.split("\n").map((s) => s.trim()).filter(Boolean);
  const mid = box.x + box.w / 2;
  const rule = box.w * 0.61;
  // Every size comes down together until the whole block fits the panel.
  for (let k = 1; ; k -= 0.06) {
    const u = (n: number) => Math.max(18, Math.round(n * k));
    const nameFit = name
      ? fit(c, name.toUpperCase(), FACE.head, { width: box.w * 0.68, lines: 2, max: u(Math.min(84, box.w * 0.13)), min: u(34), pitch: 0.95 }) : null;
    const officeFit = office.length
      ? fit(c, office.join(" "), FACE.label, { width: box.w * 0.72, lines: 2, max: u(Math.min(28, box.w * 0.05)), min: u(20), pitch: 1.3 }) : null;
    const head = fit(c, g.headline.toUpperCase(), FACE.head,
      { width: box.w * 0.75, lines: 5, max: u(Math.min(132, box.w * 0.165)), min: u(Math.min(60, box.w * 0.085)), pitch: 0.94 });
    const say = g.statement
      ? fit(c, g.statement, FACE.quote, { width: box.w * 0.71, lines: 9, max: u(Math.min(40, box.w * 0.066)), min: u(24), pitch: 1.36 }) : null;
    const parts: [number, (top: number) => void][] = [];
    const gap = (n: number) => parts.push([u(n), () => {}]);
    const line = () => parts.push([2, (top) => {
      c.fillStyle = g.accent;
      c.fillRect(mid - rule / 2, top, rule, 2);
    }]);
    if (nameFit) parts.push([nameFit.height, (top) => write(c, nameFit, FACE.head, mid, top, 0.95, "center")]);
    if (officeFit) {
      gap(10);
      parts.push([officeFit.height, (top) => write(c, officeFit, FACE.label, mid, top, 1.3, "center")]);
    }
    if (nameFit || officeFit) gap(54);
    line();
    gap(52);
    parts.push([head.height, (top) => write(c, head, FACE.head, mid, top, 0.94, "center")]);
    if (say) {
      gap(50);
      line();
      gap(36);
      parts.push([say.height, (top) => write(c, say, FACE.quote, mid, top, 1.36, "center")]);
    }
    const total = parts.reduce((t, [h]) => t + h, 0);
    if (total > box.h * 0.86 && k > 0.46) continue;
    let top = box.y + (box.h - total) / 2;
    for (const [h, paint] of parts) {
      c.fillStyle = "#fff";
      paint(top);
      top += h;
    }
    return;
  }
}

function draw(c: Ctx, g: PressGraphic, H: number, photo: Photo) {
  const M = 72;
  c.clearRect(0, 0, W, H);
  c.fillStyle = g.field;
  c.fillRect(0, 0, W, H);
  const [name, ...office] = g.kicker.split("\n").map((s) => s.trim()).filter(Boolean);
  // A story's top and foot sit under the app's own buttons, so words keep clear of them.
  const safe = H > 1500 ? { top: 220, foot: 280 } : { top: 0, foot: 0 };

  // Until a photograph is chosen, every layout is the words alone.
  if (g.layout === "type" || !photo.img) return panel(c, g, { x: 0, y: safe.top, w: W, h: H - safe.top - safe.foot });

  if (g.layout === "split") {
    // Side by side on a square; photo over panel on the taller sizes.
    const wide = H === W;
    const p = wide ? { x: 0, y: 0, w: W / 2, h: H } : { x: 0, y: 0, w: W, h: Math.round(H * 0.46) };
    cover(c, photo.img, p.x, p.y, p.w, p.h, photo.x, photo.y, rgba(g.accent, 0.35));
    return panel(c, g, wide ? { x: W / 2, y: 0, w: W / 2, h: H } : { x: 0, y: p.h, w: W, h: H - p.h - safe.foot });
  }

  if (g.layout === "bands") {
    const head = fit(c, g.headline.toUpperCase(), FACE.head, { width: W * 0.84, lines: 3, max: 112, min: 60, pitch: 0.96 });
    const topH = Math.round(safe.top + head.height + 64 + 50);
    const nameFit = name ? fit(c, name.toUpperCase(), FACE.head, { width: W * 0.6, lines: 1, max: 92, min: 48, pitch: 1 }) : null;
    const officeFit = office.length ? fit(c, office.join(" "), FACE.label, { width: W * 0.8, lines: 1, max: 30, min: 22, pitch: 1.3 }) : null;
    const say = g.statement ? fit(c, g.statement, FACE.quote, { width: W * 0.8, lines: 4, max: 36, min: 26, pitch: 1.34 }) : null;
    const footH = Math.round(52 + (nameFit?.height ?? 0) + (officeFit ? 12 + officeFit.height : 0) + (say ? 30 + say.height : 0) + 64 + safe.foot);
    cover(c, photo.img, 0, topH, W, H - topH - footH, photo.x, photo.y, rgba(g.field, 0.6));
    c.fillStyle = g.accent;
    c.fillRect(0, 0, W, topH);
    c.fillRect(0, H - footH - 4, W, 4);
    c.fillStyle = g.field;
    c.fillRect(0, H - footH, W, footH);
    c.fillStyle = "#fff";
    write(c, head, FACE.head, W / 2, safe.top + 64, 0.96, "center");
    let top = H - footH + 52;
    if (nameFit) {
      write(c, nameFit, FACE.head, W / 2, top, 1, "center");
      top += nameFit.height;
    }
    if (officeFit) {
      write(c, officeFit, FACE.label, W / 2, top + 12, 1.3, "center");
      top += 12 + officeFit.height;
    }
    if (say) write(c, say, FACE.quote, W / 2, top + 30, 1.34, "center");
    return;
  }

  // Wash: the photograph runs the whole page; the color comes up from the foot only where the words sit.
  cover(c, photo.img, 0, 0, W, H, photo.x, photo.y, g.field);
  const head = fit(c, g.headline.toUpperCase(), FACE.head, { width: W - 2 * M, lines: 4, max: 150, min: 64, pitch: 0.93 });
  const say = g.statement ? fit(c, g.statement, FACE.quote, { width: W - 2 * M - 40, lines: 6, max: 42, min: 28, pitch: 1.36 }) : null;
  const nameFit = name ? fit(c, [name.toUpperCase(), ...office].join("   "), FACE.label, { width: W - 2 * M, lines: 2, max: 30, min: 22, pitch: 1.3 }) : null;
  const block = head.height + (say ? 44 + say.height : 0) + (nameFit ? 46 + nameFit.height : 0);
  const blockTop = H - M - safe.foot - block;
  const ramp = c.createLinearGradient(0, blockTop - H * 0.3, 0, blockTop + 20);
  ramp.addColorStop(0, rgba(g.field, 0));
  ramp.addColorStop(0.55, rgba(g.field, 0.62));
  ramp.addColorStop(1, rgba(g.field, 0.88));
  c.fillStyle = ramp;
  c.fillRect(0, blockTop - H * 0.3, W, H * 0.3 + 20);
  // Not quite solid, so the photograph still shows through under the words.
  c.fillStyle = rgba(g.field, 0.88);
  c.fillRect(0, blockTop + 20, W, H - blockTop - 20);
  c.fillStyle = "#fff";
  let top = blockTop;
  write(c, head, FACE.head, M, top, 0.93, "left");
  top += head.height;
  if (say) {
    c.fillStyle = g.accent;
    c.fillRect(M, top + 18, 220, 3);
    c.fillStyle = "#fff";
    top += 44;
    write(c, say, FACE.quote, M, top, 1.36, "left");
    top += say.height;
  }
  if (nameFit) write(c, nameFit, FACE.label, M, top + 46, 1.3, "left");
}

type MakerProps = { id: string; start: PressGraphic; canEdit: boolean; fileName: string };

export function GraphicMaker({ id, start, canEdit, fileName }: MakerProps) {
  const [g, setG] = useState(start);
  const [photo, setPhoto] = useState<Photo>({ img: null, x: 0.5, y: 0.3 });
  const [photoName, setPhotoName] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, begin] = useTransition();
  const canvas = useRef<HTMLCanvasElement>(null);
  const H = SIZES[g.size][0];
  const set = <K extends keyof PressGraphic>(k: K, v: PressGraphic[K]) => {
    setSaved(false);
    setG((old) => ({ ...old, [k]: v }));
  };

  useEffect(() => {
    let live = true;
    const paint = () => {
      const c = canvas.current?.getContext("2d");
      if (live && c) draw(c, g, H, photo);
    };
    paint();
    // Draw again once the faces arrive, and say which ones did not.
    Promise.all(NEEDED.map(([font]) => document.fonts.load(font))).catch(() => []).then(() => {
      if (!live) return;
      setMissing(NEEDED.filter(([font]) => !document.fonts.check(font)).map(([, face, fallback]) => `${face} did not load, so ${fallback} is showing.`));
      paint();
    });
    return () => {
      live = false;
    };
  }, [g, H, photo]);

  const choosePhoto = (file: File | undefined) => {
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      setPhoto((p) => ({ ...p, img }));
      setPhotoName(file.name);
      setG((old) => (old.layout === "type" ? { ...old, layout: "wash" } : old));
    };
    img.src = URL.createObjectURL(file);
  };

  const download = () => {
    setMaking(true);
    const big = document.createElement("canvas");
    big.width = W * 2;
    big.height = H * 2;
    const c = big.getContext("2d")!;
    c.scale(2, 2);
    draw(c, g, H, photo);
    // A photograph saves far faster and smaller as a JPEG; flat color stays a PNG.
    const withPhoto = Boolean(photo.img) && g.layout !== "type";
    big.toBlob((blob) => {
      setMaking(false);
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName}-${g.size}.${withPhoto ? "jpg" : "png"}`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, withPhoto ? "image/jpeg" : "image/png", 0.92);
  };

  return (
    <div className="grid gap-x-12 gap-y-8 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div>
        <canvas ref={canvas} width={W} height={H} className="block h-auto w-full max-w-[420px] bg-surface-2" aria-label="The graphic as it will download" />
        {missing.map((m) => <p key={m} role="status" className="mt-2 text-sm text-warn-ink">{m}</p>)}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <Field label="Layout" htmlFor="g-layout">
            <Select id="g-layout" value={g.layout} onChange={(e) => set("layout", e.target.value as PressGraphic["layout"])}>
              {Object.entries(LAYOUTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Size" htmlFor="g-size">
            <Select id="g-size" value={g.size} onChange={(e) => set("size", e.target.value as PressGraphic["size"])}>
              {Object.entries(SIZES).map(([k, [, label]]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Headline" htmlFor="g-headline">
          <Input id="g-headline" value={g.headline} onChange={(e) => set("headline", e.target.value)} maxLength={160} />
        </Field>
        <Field label="Statement" htmlFor="g-statement">
          <Textarea id="g-statement" rows={3} value={g.statement} onChange={(e) => set("statement", e.target.value)} maxLength={400} className="text-base" />
        </Field>
        <Field label="Name, then office on the next line" htmlFor="g-kicker">
          <Textarea id="g-kicker" rows={2} value={g.kicker} onChange={(e) => set("kicker", e.target.value)} maxLength={120} className="text-base" />
        </Field>
        <div className="grid items-end gap-x-6 gap-y-4 sm:grid-cols-3">
            <div>
              <label htmlFor="g-photo" className="inline-flex h-10 cursor-pointer items-center border border-line-strong px-5 text-sm font-semibold
                whitespace-nowrap text-ink transition-colors hover:border-ink">
                {photoName ? "Choose another photo" : "Choose a photo"}
              </label>
              <input id="g-photo" type="file" accept="image/*" className="sr-only" onChange={(e) => choosePhoto(e.target.files?.[0])} />
              {photoName && <p className="mt-1.5 truncate text-sm text-ink-2">{photoName}</p>}
            </div>
            {photo.img && g.layout !== "type" && (
              <>
                <Field label="Move it left or right" htmlFor="g-px">
                  <input id="g-px" type="range" min={0} max={100} value={Math.round(photo.x * 100)}
                    onChange={(e) => setPhoto((p) => ({ ...p, x: Number(e.target.value) / 100 }))} />
                </Field>
                <Field label="Move it up or down" htmlFor="g-py">
                  <input id="g-py" type="range" min={0} max={100} value={Math.round(photo.y * 100)}
                    onChange={(e) => setPhoto((p) => ({ ...p, y: Number(e.target.value) / 100 }))} />
                </Field>
              </>
            )}
        </div>
        <div className="grid max-w-sm grid-cols-2 gap-x-6">
          <Field label="Main color" htmlFor="g-field">
            <input id="g-field" type="color" value={g.field} onChange={(e) => set("field", e.target.value)} className="h-10 w-full" />
          </Field>
          <Field label="Second color" htmlFor="g-accent">
            <input id="g-accent" type="color" value={g.accent} onChange={(e) => set("accent", e.target.value)} className="h-10 w-full" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="primary" disabled={making} onClick={download}>{making ? "Making the picture" : "Download the picture"}</Button>
          {canEdit && (
            <Button type="button" disabled={pending || saved} onClick={() => begin(async () => {
              const r = await saveGraphicAction(id, g);
              setSaved(r.ok);
              setError(r.ok ? null : r.error);
            })}>
              {saved ? "Saved" : "Save these choices"}
            </Button>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}
