// Hero view: blueprint aircraft flying its reconstructed path, followed by the camera.
// HTML overlay: voices (CVR / ATC / witnesses / interviews) and system cards with leader lines to the
// aircraft part they concern, anomaly tags pinned to parts, and causal links on hover.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fmtT } from "../api";
import { ADI, ZoneBody, clamp, dt, f } from "../components/cards";
import { SourceTag } from "../components/SourceTag";
import {
  ZONES, byZone, discreteIndex, seriesMap, valueAt, vsAt, zoneOfAnomaly, zoneOfEvent, zoneOfText,
  type SeriesMap, type ZoneId,
} from "../data";
import type { Anomaly, CaseGraph, Event, Selection } from "../types";

type Cam = "chase" | "side" | "top" | "orbit";
const CAMS: [Cam, string][] = [["chase", "Chase"], ["side", "Side 2D"], ["top", "Top"], ["orbit", "Orbit"]];
const SYSTEM_CARDS: [ZoneId, string][] = [
  ["airdata", "AIR DATA · STALL"], ["autoflight", "AUTOFLIGHT"], ["engines", "POWERPLANTS"],
  ["empennage", "FLIGHT CONTROLS"], ["gear", "LANDING GEAR"],
];
const C = { line: 0x8ec5ff, accent: 0x5ee1ff, warn: 0xffb547, crit: 0xff5d5d, fill: 0x0c2a50, grid: 0x1d4472, gridFine: 0x2a5a8f };

// ------------------------------------------------------------------ path

interface PathPt { t: number; p: THREE.Vector3 }
interface GeoRef { lat0: number; lon0: number; k: number }

const toScene = (r: GeoRef, lat: number, lon: number) => new THREE.Vector3((lon - r.lon0) * r.k * 111320, 0, -(lat - r.lat0) * 110540);

function buildPath(g: CaseGraph, sm: SeriesMap): { pts: PathPt[]; source: string; ref: GeoRef | null } {
  const altS = sm.get("altitude_ft");
  const tr = g.track.filter((p) => p.t_s !== null && isFinite(p.lat) && isFinite(p.lon)).sort((a, b) => a.t_s! - b.t_s!);
  if (tr.length > 1) {
    const last = tr[tr.length - 1];
    const k = Math.cos((last.lat * Math.PI) / 180);
    const srcFile = g.series.find((s) => s.name === "altitude_ft")?.source_file;
    const srcName = g.files.find((f) => f.file_id === srcFile)?.role === "fdr_data" ? "FDR lat/lon" : "ADS-B / radar track";
    return {
      ref: { lat0: last.lat, lon0: last.lon, k },
      source: srcName + (altS ? " + FDR altitude" : ""),
      pts: tr.map((p) => {
        const alt = valueAt(altS, p.t_s) ?? p.alt_ft ?? 0;
        return { t: p.t_s!, p: new THREE.Vector3((p.lon - last.lon) * k * 111320, Math.max(0, alt) * 0.3048, -(p.lat - last.lat) * 110540) };
      }),
    };
  }
  // Fallback: dead-reckon from airspeed + heading so the aircraft still flies.
  if (altS && altS.points.length > 1) {
    const ias = sm.get("airspeed_kt"), hdg = sm.get("heading_deg");
    const pts: PathPt[] = [];
    let x = 0, z = 0, prev = altS.points[0][0];
    for (const [t, a] of altS.points) {
      const v = (valueAt(ias, t) ?? 250) * 0.5144, h = ((valueAt(hdg, t) ?? 90) * Math.PI) / 180, d = t - prev;
      x += Math.sin(h) * v * d; z -= Math.cos(h) * v * d; prev = t;
      pts.push({ t, p: new THREE.Vector3(x, Math.max(0, a) * 0.3048, z) });
    }
    return { pts, source: "dead reckoning (FDR alt/IAS/heading)", ref: null };
  }
  return { pts: [], source: "no track data", ref: null };
}

// ------------------------------------------------------------------ ground: map tiles + labels

const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y: number, z: number) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const lon2tile = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2tile = (lat: number, z: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

/** OpenStreetMap standard tiles (no API key; CARTO now requires one) laid on the ground plane.
 * The shader inverts luminance so land goes dark and water / coastlines / roads / labels glow as blueprint linework;
 * additive blending lets the black drop out. Keep the tile count low (OSM tile usage policy). */
function invertedMaterial(opacity: number) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xa9d4ff, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#ifdef USE_MAP
        vec4 texel = texture2D( map, vMapUv );
        float lum = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) );
        diffuseColor.rgb *= vec3( pow( clamp( 1.0 - lum, 0.0, 1.0 ), 1.4 ) );
      #endif`,
    );
  };
  return mat;
}

function addTiles(group: THREE.Group, ref: GeoRef, box: [number, number, number, number], zoom: number, y: number, opacity: number, maxTiles = 64) {
  const [latMin, latMax, lonMin, lonMax] = box;
  const x0 = lon2tile(lonMin, zoom), x1 = lon2tile(lonMax, zoom), y0 = lat2tile(latMax, zoom), y1 = lat2tile(latMin, zoom);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles) return;
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
    const nw = toScene(ref, tile2lat(ty, zoom), tile2lon(tx, zoom)), se = toScene(ref, tile2lat(ty + 1, zoom), tile2lon(tx + 1, zoom));
    const mat = invertedMaterial(opacity);
    loader.load(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, (tex) => { tex.colorSpace = THREE.SRGBColorSpace; mat.map = tex; mat.needsUpdate = true; });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(se.x - nw.x, se.z - nw.z).rotateX(-Math.PI / 2), mat);
    m.position.set((nw.x + se.x) / 2, y, (nw.z + se.z) / 2);
    m.renderOrder = -1;
    group.add(m);
  }
}

function label(text: string, color = "#8ec5ff", scale = 1) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 48;
  const g = c.getContext("2d")!;
  g.font = "500 22px IBM Plex Mono, monospace";
  g.fillStyle = "rgba(8,28,54,0.75)"; g.fillRect(0, 6, Math.min(256, g.measureText(text).width + 16), 34);
  g.fillStyle = color; g.fillText(text, 8, 31);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, sizeAttenuation: false }));
  sp.scale.set(0.16 * scale, 0.03 * scale, 1);
  sp.center.set(0, 0);
  return sp;
}

function poseAt(pts: PathPt[], t: number): { pos: THREE.Vector3; hdg: number; idx: number } | null {
  if (!pts.length) return null;
  if (t <= pts[0].t) t = pts[0].t;
  if (t >= pts[pts.length - 1].t) t = pts[pts.length - 1].t;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  const pos = a.p.clone().lerp(b.p, u);
  const i0 = Math.max(0, lo - 1), i1 = Math.min(pts.length - 1, hi + 1);
  const d = pts[i1].p.clone().sub(pts[i0].p);
  const hdg = (Math.atan2(d.x, -d.z) * 180) / Math.PI;
  return { pos, hdg, idx: lo };
}

// ------------------------------------------------------------------ aircraft model

interface Model { group: THREE.Group; edges: Map<ZoneId, THREE.LineBasicMaterial[]>; anchors: Record<ZoneId, THREE.Vector3>; gear: THREE.Group }

function makeAircraft(): Model {
  const group = new THREE.Group();
  group.rotation.order = "YZX";
  const edges = new Map<ZoneId, THREE.LineBasicMaterial[]>();
  const fill = new THREE.MeshBasicMaterial({ color: C.fill, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: true });
  const add = (geo: THREE.BufferGeometry, zone: ZoneId, parent: THREE.Object3D = group, tf?: (m: THREE.Object3D) => void) => {
    const mesh = new THREE.Mesh(geo, fill);
    const mat = new THREE.LineBasicMaterial({ color: C.line });
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), mat));
    tf?.(mesh);
    parent.add(mesh);
    if (!edges.has(zone)) edges.set(zone, []);
    edges.get(zone)!.push(mat);
    return mesh;
  };
  const extrude = (pts: [number, number][], depth: number) => {
    const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
    return geo;
  };
  // fuselage (structure), nose (flight deck), tail cone
  add(new THREE.CylinderGeometry(2.7, 2.7, 40, 28, 1, true).rotateZ(Math.PI / 2).translate(2, 0, 0), "structure");
  add(new THREE.SphereGeometry(2.7, 28, 14).scale(2.6, 1, 1).translate(22, 0, 0), "cockpit");
  add(new THREE.ConeGeometry(2.7, 13, 28, 1, true).rotateZ(Math.PI / 2).translate(-24.5, 0.6, 0), "structure");
  // windshield
  add(new THREE.BoxGeometry(2.4, 0.9, 3.2).translate(25.2, 1.5, 0), "cockpit");
  // wings (planform in x/span), low wing with dihedral
  const wing = extrude([[7, 0], [-8, 23], [-11.5, 23], [-3, 0]], 0.5).rotateX(Math.PI / 2);
  add(wing.clone(), "wings", group, (m) => { m.position.set(0, -1.6, 2.4); m.rotation.x = -0.08; });
  add(wing.clone().scale(1, 1, -1), "wings", group, (m) => { m.position.set(0, -1.6, -2.4); m.rotation.x = 0.08; });
  // horizontal stabiliser + vertical fin (empennage)
  const hs = extrude([[-19, 0], [-26, 9], [-28.5, 9], [-24.5, 0]], 0.3).rotateX(Math.PI / 2);
  add(hs.clone(), "empennage", group, (m) => { m.position.set(0, 1, 1.2); });
  add(hs.clone().scale(1, 1, -1), "empennage", group, (m) => { m.position.set(0, 1, -1.2); });
  add(extrude([[-16, 2.2], [-25.5, 12.5], [-29, 12.5], [-27, 2.2]], 0.35), "empennage");
  // engines + pylons
  for (const s of [1, -1]) {
    add(new THREE.CylinderGeometry(1.5, 1.25, 7, 22, 1, true).rotateZ(Math.PI / 2).translate(5.5, -3.3, 8 * s), "engines");
    add(new THREE.BoxGeometry(4, 1.6, 0.4).translate(4.5, -2.1, 8 * s), "engines");
  }
  // antennas
  add(new THREE.BoxGeometry(0.8, 1.2, 0.2).translate(10, 3.1, 0), "comms");
  add(new THREE.BoxGeometry(0.8, 1.2, 0.2).translate(-4, 3.1, 0), "comms");
  // pitot / AoA
  add(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 6).rotateZ(Math.PI / 2).translate(26.5, -0.6, 1.9), "airdata");
  add(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 6).rotateZ(Math.PI / 2).translate(26.5, -0.6, -1.9), "airdata");
  // gear
  const gear = new THREE.Group();
  group.add(gear);
  for (const [x, z] of [[-1, 3.2], [-1, -3.2], [18, 0]] as [number, number][]) {
    add(new THREE.CylinderGeometry(0.2, 0.2, 2.6, 6).translate(x, -3.6, z), "gear", gear);
    add(new THREE.CylinderGeometry(0.75, 0.75, 0.6, 14).rotateX(Math.PI / 2).translate(x, -5, z), "gear", gear);
  }
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const anchors: Record<ZoneId, THREE.Vector3> = {
    cockpit: V(23, 2.2, 0), airdata: V(26.5, -0.6, 1.9), autoflight: V(24, 2.4, 0), comms: V(10, 3.6, 0),
    engines: V(6, -3.3, 8), wings: V(-9, -1.4, 21), empennage: V(-26, 11, 0), gear: V(-1, -5.2, 3.2),
    structure: V(-18, 1.6, 0), environment: V(0, 14, 0),
  };
  return { group, edges, anchors, gear };
}

// ------------------------------------------------------------------ voices

type VoiceKind = "CVR" | "ATC" | "WITNESS" | "INTERVIEW" | "PARTY" | "STATEMENT";
interface Voice { key: string; kind: VoiceKind; who: string; t: number | null; text: string; zone: ZoneId; sel: Selection; anomalyId?: string; atom: Event | Anomaly }

// The card type follows the SOURCE DOCUMENT first (a party submission quoting the CVR is still a party claim).
function kindOf(role: string | undefined, claimedBy: string | null, lane?: string): VoiceKind {
  if (role === "party_submission") return "PARTY";
  if (role === "interview") return "INTERVIEW";
  if (claimedBy && /witness/i.test(claimedBy)) return "WITNESS";
  if (role === "cvr_transcript") return "CVR";
  if (role === "atc" || role === "audio") return "ATC";
  if (lane === "cockpit") return role ? "STATEMENT" : "CVR";
  if (lane === "atc") return "ATC";
  return "STATEMENT";
}

// ------------------------------------------------------------------ component

interface Props { g: CaseGraph; cursor: number | null; selected: Selection; onSelect: (s: Selection) => void }

export function FlightView({ g, cursor, selected, onSelect }: Props) {
  const sm = useMemo(() => seriesMap(g.series), [g.series]);
  const di = useMemo(() => discreteIndex(g.events), [g.events]);
  const zones = useMemo(() => byZone(g), [g]);
  const roles = useMemo(() => new Map(g.files.map((x) => [x.file_id, x.role])), [g.files]);
  const { pts, source, ref: geo } = useMemo(() => buildPath(g, sm), [g, sm]);
  const [mapOn, setMapOn] = useState(true);
  const tEnd = pts.length ? pts[pts.length - 1].t : (cursor ?? 0);
  const t = cursor ?? tEnd;
  const [cam, setCam] = useState<Cam>(() => (location.hash.match(/cam=(chase|side|top|orbit)/)?.[1] as Cam) ?? "chase");
  const [hoverZone, setHoverZone] = useState<ZoneId | null>(null);
  const [hoverAn, setHoverAn] = useState<string | null>(null);

  // --- flight state at t
  const v = (n: string) => valueAt(sm.get(n), t);
  const alt = v("altitude_ft"), ias = v("airspeed_kt"), pitch = v("pitch_deg"), roll = v("roll_deg");
  const vs = vsAt(sm, t), aoa = v("aoa_deg");
  const fpa = vs !== null && ias ? (Math.atan2(vs / 60, Math.max(60, ias) * 1.688) * 180) / Math.PI : null;
  const gearState = [...di.entries()].find(([k]) => /gear/i.test(k));
  const gearUp = gearState ? /up|retract/i.test(gearState[1].filter((x) => x.t <= t).pop()?.to ?? gearState[1][0].from) : (alt ?? 0) > 2500;

  // --- anomalies: active (t <= cursor), alarm (last 12 s), plus hover partners
  const anById = useMemo(() => new Map(g.anomalies.map((a) => [a.id, a])), [g.anomalies]);
  const links = useMemo(() => {
    const m = new Map<string, { other: string; relation: string; dir: "out" | "in"; rationale: string; conf: number }[]>();
    for (const e of g.causal_edges) {
      (m.get(e.source) ?? m.set(e.source, []).get(e.source)!).push({ other: e.target, relation: e.relation, dir: "out", rationale: e.rationale, conf: e.confidence });
      (m.get(e.target) ?? m.set(e.target, []).get(e.target)!).push({ other: e.source, relation: e.relation, dir: "in", rationale: e.rationale, conf: e.confidence });
    }
    return m;
  }, [g.causal_edges]);
  const sevRank = { critical: 0, significant: 1, minor: 2, info: 3 } as const;
  const tags = useMemo(() => {
    const timed = g.anomalies.filter((a) => a.time?.t_s != null && a.time.t_s <= t).sort((a, b) => b.time!.t_s! - a.time!.t_s!).slice(0, 6);
    const latent = g.anomalies.filter((a) => a.time?.t_s == null && sevRank[a.severity] <= 1).slice(0, 4);
    // at most 3 tags per aircraft part (newest first); hovered tag + its causal partners always shown
    const set = new Map<string, Anomaly>();
    const perZone = new Map<ZoneId, number>();
    for (const a of [...timed, ...latent]) {
      const z = zoneOfAnomaly(a), n = perZone.get(z) ?? 0;
      perZone.set(z, n + 1);
      if (n < 3) set.set(a.id, a);
    }
    if (hoverAn) {
      const h = anById.get(hoverAn); if (h) set.set(h.id, h);
      (links.get(hoverAn) ?? []).forEach((l) => { const o = anById.get(l.other); if (o) set.set(o.id, o); });
    }
    return [...set.values()];
  }, [g.anomalies, t, hoverAn, links, anById]);
  const alarmZones = useMemo(() => {
    const s = new Set<ZoneId>();
    g.anomalies.forEach((a) => { if (a.time?.t_s != null && a.time.t_s <= t && a.time.t_s > t - 12) s.add(zoneOfAnomaly(a)); });
    return s;
  }, [g.anomalies, t]);

  // --- voices: recent CVR / ATC + testimony (claims) relevant to what is happening
  const voices = useMemo<Voice[]>(() => {
    const out: Voice[] = [];
    const recent = g.events.filter((e) => (e.lane === "cockpit" || e.lane === "atc") && e.time.t_s !== null && e.time.t_s <= t && e.time.t_s > t - 240)
      .slice(-3);
    for (const e of recent) {
      out.push({ key: e.id, kind: kindOf(roles.get(e.source_files[0]), e.claimed_by, e.lane), who: e.actor ?? "", t: e.time.t_s, text: e.citations[0]?.quote || e.description,
        zone: e.lane === "atc" ? "comms" : zoneOfText(e.description) ?? "cockpit", sel: { kind: "event", item: e }, atom: e });
    }
    const claims: Voice[] = [];
    for (const a of g.anomalies) if (a.certainty === "claimed" && (a.time?.t_s == null || a.time.t_s <= t))
      claims.push({ key: a.id, kind: kindOf(roles.get(a.source_files[0]), /witness/i.test(a.title + a.observed) ? "witness" : null), who: a.title, t: a.time?.t_s ?? null, text: a.citations[0]?.quote || a.observed,
        zone: zoneOfAnomaly(a), sel: { kind: "anomaly", item: a }, anomalyId: a.id, atom: a });
    for (const e of g.events) if (e.certainty === "claimed" && (e.time.t_s === null || e.time.t_s <= t) && e.lane !== "cockpit" && e.lane !== "atc")
      claims.push({ key: e.id, kind: kindOf(roles.get(e.source_files[0]), e.claimed_by), who: e.claimed_by ?? e.actor ?? "", t: e.time.t_s, text: e.citations[0]?.quote || e.description,
        zone: zoneOfEvent(e), sel: { kind: "event", item: e }, atom: e });
    // prefer testimony about systems that are currently in alarm, then timed, then the rest
    claims.sort((a, b) => Number(alarmZones.has(b.zone)) - Number(alarmZones.has(a.zone)) || (b.t ?? -1e12) - (a.t ?? -1e12));
    return [...out, ...claims.slice(0, 3)];
  }, [g.events, g.anomalies, t, roles, alarmZones]);

  // ------------------------------------------------------------------ three.js
  const wrap = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const live = useRef({ t, cam, pts, hoverZone, alarmZones, gearUp, pitch, roll, hoverAn });
  live.current = { t, cam, pts, hoverZone, alarmZones, gearUp, pitch, roll, hoverAn };
  const cardEls = useRef(new Map<string, { el: HTMLElement; zone: ZoneId; side: "l" | "r" }>());
  const tagEls = useRef(new Map<string, { el: HTMLElement; zone: ZoneId; slot: number }>());
  const lineEls = useRef(new Map<string, SVGPathElement>());
  const linkEls = useRef(new Map<string, SVGPathElement>());
  const scene3 = useRef<{ scene: THREE.Scene; flown: THREE.Line; markers: THREE.Group; pathGroup: THREE.Group; ground: THREE.Group; labels: THREE.Group; detail: THREE.Group } | null>(null);

  useEffect(() => {
    const el = mount.current!, ov = overlay.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a2342, 4000, 90000);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400000);
    // Orbit controls in every mode: the target follows the aircraft, the user rotates / zooms around it.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = 25;
    controls.maxDistance = 60000;
    controls.maxPolarAngle = Math.PI * 0.495;

    const big = new THREE.GridHelper(400000, 400, C.grid, C.grid);
    (big.material as THREE.Material).transparent = true; (big.material as THREE.Material).opacity = 0.35;
    big.position.y = 0.5;
    scene.add(big);
    const ground = new THREE.Group(); scene.add(ground);
    const detail = new THREE.Group(); scene.add(detail);
    const labels = new THREE.Group(); scene.add(labels);
    const fine = new THREE.GridHelper(4000, 40, C.gridFine, C.gridFine);
    (fine.material as THREE.Material).transparent = true; (fine.material as THREE.Material).opacity = 0.35;
    scene.add(fine);
    const pathGroup = new THREE.Group(); scene.add(pathGroup);
    const markers = new THREE.Group(); scene.add(markers);
    const flown = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: C.accent }));
    scene.add(flown);
    const model = makeAircraft();
    scene.add(model.group);
    const shadow = new THREE.Mesh(new THREE.RingGeometry(18, 22, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.warn, transparent: true, opacity: 0.5 }));
    scene.add(shadow);
    const drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: C.warn, dashSize: 30, gapSize: 20 }));
    scene.add(drop);
    scene3.current = { scene, flown, markers, pathGroup, ground, labels, detail };

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
      ov.setAttribute("viewBox", `0 0 ${w} ${h}`);
    });
    ro.observe(el);

    const prevTarget = new THREE.Vector3();
    let lastCam: Cam | null = null, raf = 0, frame = 0, prevYaw = 0;
    const tmp = new THREE.Vector3();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      frame++;
      const L = live.current;
      const pose = poseAt(L.pts, L.t);
      const pos = pose?.pos ?? new THREE.Vector3(0, 300, 0);
      const hdg = pose?.hdg ?? 90;
      const yaw = ((90 - hdg) * Math.PI) / 180;
      model.group.position.copy(pos);
      model.group.rotation.set(((L.roll ?? 0) * Math.PI) / 180, yaw, ((L.pitch ?? 0) * Math.PI) / 180);
      model.gear.visible = !L.gearUp;
      shadow.position.set(pos.x, 0.5, pos.z);
      (drop.geometry as THREE.BufferGeometry).setFromPoints([pos, new THREE.Vector3(pos.x, 0, pos.z)]);
      drop.computeLineDistances();
      fine.position.set(Math.round(pos.x / 100) * 100, 0.2, Math.round(pos.z / 100) * 100);
      if (pose) flown.geometry.setDrawRange(0, pose.idx + 1);

      // part colours: alarm (blinking red) > hover > normal
      const blink = Math.floor(frame / 20) % 2 === 0;
      model.edges.forEach((mats, z) => mats.forEach((m) => m.color.setHex(L.alarmZones.has(z) ? (blink ? C.crit : 0x99404a) : L.hoverZone === z ? C.accent : C.line)));

      // camera
      const fwd = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const right = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)); // body +z after yaw
      if (L.cam !== lastCam) {
        // preset placement (user can orbit / zoom from here); side uses a narrow FOV for a flat, 2D-like profile
        const preset = L.cam === "chase" ? pos.clone().addScaledVector(fwd, -62).addScaledVector(right, 22).add(new THREE.Vector3(0, 14, 0))
          : L.cam === "side" ? pos.clone().addScaledVector(right, 330).add(new THREE.Vector3(0, 4, 0))
          : L.cam === "top" ? pos.clone().addScaledVector(fwd, -60).add(new THREE.Vector3(0, 2500, 0))
          : pos.clone().add(new THREE.Vector3(-260, 140, 260));
        camera.fov = L.cam === "side" ? 14 : 50;
        camera.updateProjectionMatrix();
        camera.position.copy(preset);
        controls.target.copy(pos);
        prevTarget.copy(pos); prevYaw = yaw;
        lastCam = L.cam;
      }
      // follow: move the camera with the aircraft; in chase/side also turn with its heading
      camera.position.add(pos.clone().sub(prevTarget));
      if (L.cam === "chase" || L.cam === "side") {
        const dy = yaw - prevYaw;
        if (Math.abs(dy) > 1e-6 && Math.abs(dy) < Math.PI) {
          const off = camera.position.clone().sub(pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), dy);
          camera.position.copy(pos).add(off);
        }
      }
      controls.target.copy(pos);
      prevTarget.copy(pos); prevYaw = yaw;
      controls.update();
      renderer.render(scene, camera);

      // ---- overlay: project anchors, place tags, draw leader lines
      const W = el.clientWidth, H = el.clientHeight, box = el.getBoundingClientRect();
      const anchor = new Map<ZoneId, { x: number; y: number; vis: boolean }>();
      (Object.keys(model.anchors) as ZoneId[]).forEach((z) => {
        tmp.copy(model.anchors[z]); model.group.localToWorld(tmp); tmp.project(camera);
        anchor.set(z, { x: ((tmp.x + 1) / 2) * W, y: ((1 - tmp.y) / 2) * H, vis: tmp.z < 1 && Math.abs(tmp.x) < 1.3 && Math.abs(tmp.y) < 1.3 });
      });
      const tagPos = new Map<string, { x: number; y: number }>();
      const placed: { x: number; y: number; w: number }[] = [];
      tagEls.current.forEach(({ el: te, zone, slot }, id) => {
        const a = anchor.get(zone)!;
        // stack tags of one part upward, on the outer side of the part; then push up until no overlap
        const side = a.x > W / 2 ? 1 : -1;
        const tw = te.offsetWidth || 160;
        const x = clamp(side > 0 ? a.x + 36 : a.x - 36 - tw, 290, W - 290 - tw);
        let y = clamp(a.y - 46 - slot * 27, 60, H - 40);
        for (let guard = 0; guard < 20 && placed.some((p) => x < p.x + p.w + 6 && x + tw + 6 > p.x && Math.abs(y - p.y) < 25); guard++) y -= 26;
        if (y < 50) y = 50 + placed.length * 26;
        placed.push({ x, y, w: tw });
        te.style.transform = `translate(${x}px, ${y}px)`;
        te.style.opacity = a.vis ? "1" : "0.25";
        const ex = side > 0 ? x : x + tw;
        tagPos.set(id, { x: x + tw / 2, y: y + 11 });
        const ln = lineEls.current.get(`tag-${id}`);
        if (ln) ln.setAttribute("d", `M${ex} ${y + 11} L${a.x} ${a.y}`);
      });
      cardEls.current.forEach(({ el: ce, zone, side }, key) => {
        const ln = lineEls.current.get(key);
        if (!ln) return;
        const r = ce.getBoundingClientRect();
        const a = anchor.get(zone)!;
        const sx = side === "l" ? r.right - box.left : r.left - box.left, sy = r.top - box.top + Math.min(22, r.height / 2);
        const mx = side === "l" ? sx + 28 : sx - 28;
        ln.setAttribute("d", `M${sx} ${sy} L${mx} ${sy} L${a.x} ${a.y}`);
        ln.style.opacity = a.vis ? "" : "0.15";
      });
      linkEls.current.forEach((ln, key) => {
        const [a, b] = key.split("|");
        const pa = tagPos.get(a), pb = tagPos.get(b);
        if (!pa || !pb) { ln.setAttribute("d", ""); return; }
        const mx = (pa.x + pb.x) / 2, my = Math.min(pa.y, pb.y) - 60;
        ln.setAttribute("d", `M${pa.x} ${pa.y} Q${mx} ${my} ${pb.x} ${pb.y}`);
      });
    };
    loop();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, []);

  // path + anomaly markers
  useEffect(() => {
    const s = scene3.current; if (!s) return;
    s.pathGroup.clear(); s.markers.clear(); s.labels.clear();
    if (pts.length < 2) return;
    // time marks along the path (adaptive interval, ≤ ~30 labels), plus start / end
    const span = pts[pts.length - 1].t - pts[0].t;
    const every = [30, 60, 120, 300, 600, 900, 1800].find((x) => span / x <= 30) ?? 3600;
    const tick: THREE.Vector3[] = [];
    for (let tt = Math.ceil(pts[0].t / every) * every; tt < pts[pts.length - 1].t; tt += every) {
      const pose = poseAt(pts, tt); if (!pose) continue;
      const l = label(fmtT(tt).slice(0, 5), "#8ec5ff", 0.8);
      l.position.copy(pose.pos);
      s.labels.add(l);
      tick.push(pose.pos, new THREE.Vector3(pose.pos.x, 0, pose.pos.z));
    }
    s.labels.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tick), new THREE.LineBasicMaterial({ color: C.accent, transparent: true, opacity: 0.35 })));
    const first = label(`START ${fmtT(pts[0].t)}`, "#6ee7a8"); first.position.copy(pts[0].p); s.labels.add(first);
    const last = label(`LAST POINT ${fmtT(pts[pts.length - 1].t)}`, "#ff5d5d"); last.position.copy(pts[pts.length - 1].p).setY(0); s.labels.add(last);
    const ring = new THREE.Mesh(new THREE.RingGeometry(380, 400, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.crit, transparent: true, opacity: 0.6 }));
    ring.position.copy(pts[pts.length - 1].p).setY(1); s.labels.add(ring);
    const vs3 = pts.map((p) => p.p);
    s.pathGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs3), new THREE.LineBasicMaterial({ color: C.line, transparent: true, opacity: 0.3 })));
    const sh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs3.map((v) => new THREE.Vector3(v.x, 1, v.z))),
      new THREE.LineDashedMaterial({ color: C.line, dashSize: 120, gapSize: 80, transparent: true, opacity: 0.35 }));
    sh.computeLineDistances(); s.pathGroup.add(sh);
    const step = Math.max(1, Math.floor(vs3.length / 160));
    const cur: THREE.Vector3[] = [];
    for (let i = 0; i < vs3.length; i += step) cur.push(vs3[i], new THREE.Vector3(vs3[i].x, 0, vs3[i].z));
    s.pathGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cur), new THREE.LineBasicMaterial({ color: C.line, transparent: true, opacity: 0.08 })));
    s.flown.geometry.dispose();
    s.flown.geometry = new THREE.BufferGeometry().setFromPoints(vs3);
    for (const a of g.anomalies) {
      if (a.time?.t_s == null) continue;
      const pose = poseAt(pts, a.time.t_s); if (!pose) continue;
      const col = a.severity === "critical" ? C.crit : a.severity === "significant" ? C.warn : C.line;
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(6), new THREE.MeshBasicMaterial({ color: col, wireframe: true }));
      m.position.copy(pose.pos);
      s.markers.add(m);
      s.markers.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pose.pos, new THREE.Vector3(pose.pos.x, 0, pose.pos.z)]),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 })));
    }
  }, [pts, g.anomalies]);

  // ground: basemap tiles — overview of the whole route + detail around the final position
  useEffect(() => {
    const s = scene3.current; if (!s) return;
    s.ground.clear();
    if (!mapOn || !geo || pts.length < 2) return;
    const lats = g.track.map((p) => p.lat), lons = g.track.map((p) => p.lon);
    const pad = 0.4;
    const box: [number, number, number, number] = [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lons) - pad, Math.max(...lons) + pad];
    const zOver = [9, 8, 7, 6, 5, 4].find((z) => (lon2tile(box[3], z) - lon2tile(box[2], z) + 1) * (lat2tile(box[0], z) - lat2tile(box[1], z) + 1) <= 48) ?? 4;
    addTiles(s.ground, geo, box, zOver, -1, 0.6);
  }, [mapOn, geo, pts.length, g.track]);

  // sharp zoom-14 patch with place / road labels (5×5 tiles ≈ 10 km) that follows the aircraft;
  // rebuilt only when it crosses a tile. Lower layers are label-free so nothing bleeds through (additive blending).
  const DETAIL_Z = 14;
  const here = geo && pts.length ? poseAt(pts, t)?.pos : null;
  const hereLat = here && geo ? geo.lat0 - here.z / 110540 : null;
  const hereLon = here && geo ? geo.lon0 + here.x / (geo.k * 111320) : null;
  const tileKey = hereLat !== null && hereLon !== null ? `${lon2tile(hereLon, DETAIL_Z)}/${lat2tile(hereLat, DETAIL_Z)}` : "";
  useEffect(() => {
    const s = scene3.current; if (!s) return;
    s.detail.clear();
    if (!mapOn || !geo || !tileKey) return;
    const [tx, ty] = tileKey.split("/").map(Number);
    addTiles(s.detail, geo, [tile2lat(ty + 4, DETAIL_Z), tile2lat(ty - 3, DETAIL_Z), tile2lon(tx - 3, DETAIL_Z), tile2lon(tx + 4, DETAIL_Z)], DETAIL_Z, 1, 0.9, 64); // tile range is inclusive: 8×8
  }, [mapOn, geo, tileKey]);

  // ------------------------------------------------------------------ render overlay
  const tagSlots = new Map<ZoneId, number>();
  const hoverLinks = hoverAn ? links.get(hoverAn) ?? [] : [];
  const regCard = (key: string, zone: ZoneId, side: "l" | "r") => (el: HTMLElement | null) => {
    if (el) cardEls.current.set(key, { el, zone, side }); else cardEls.current.delete(key);
  };
  const regLine = (key: string) => (el: SVGPathElement | null) => { if (el) lineEls.current.set(key, el); else lineEls.current.delete(key); };

  return (
    <div className="flight" ref={wrap}>
      <div ref={mount} className="flight-canvas" />
      <svg ref={overlay} className="flight-overlay">
        {voices.map((vc) => <path key={vc.key} ref={regLine(vc.key)} className={`lead voice ${hoverZone === vc.zone ? "hl" : ""}`} />)}
        {SYSTEM_CARDS.map(([z]) => <path key={z} ref={regLine(`sys-${z}`)} className={`lead ${alarmZones.has(z) ? "alarm" : ""} ${hoverZone === z ? "hl" : ""}`} />)}
        {tags.map((a) => <path key={a.id} ref={regLine(`tag-${a.id}`)} className={`lead tagline sev-${a.severity}`} />)}
        {hoverLinks.map((l) => (
          <path key={l.other} ref={(el) => { const k = `${hoverAn}|${l.other}`; if (el) linkEls.current.set(k, el); else linkEls.current.delete(k); }}
            className={`causal ${l.relation === "contradicts" ? "contra" : ""}`} markerEnd="url(#fv-arrow)" />
        ))}
        <defs><marker id="fv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--warn)" /></marker></defs>
      </svg>

      {/* camera + source */}
      <div className="cam-bar">
        {CAMS.map(([k, lbl]) => <button key={k} className={`btn ${cam === k ? "active" : ""}`} onClick={() => setCam(k)}>{lbl}</button>)}
        <button className={`btn ${mapOn ? "active" : ""}`} onClick={() => setMapOn(!mapOn)} title="Basemap tiles on the ground">Map</button>
        <span className="label" style={{ marginLeft: 8 }}>path: {source}</span>
      </div>
      {mapOn && geo && <div className="attrib">© OpenStreetMap contributors · drag to orbit · scroll to zoom</div>}

      {/* left column: HUD + voices */}
      <div className="col left">
        <div className="card hud">
          <ADI pitch={pitch ?? 0} roll={roll ?? 0} fpa={fpa} size={104} />
          <div className="hudvals">
            <div><span>ALT</span><b>{f(alt, 0)}</b><small>ft</small></div>
            <div><span>IAS</span><b>{f(ias, 0)}</b><small>kt</small></div>
            <div className={vs !== null && vs < -4000 ? "bad" : ""}><span>V/S</span><b>{f(vs, 0)}</b><small>fpm</small></div>
            <div className={Math.abs(pitch ?? 0) > 20 ? "bad" : ""}><span>θ</span><b>{f(pitch, 1)}</b><small>°</small></div>
            <div className={Math.abs(roll ?? 0) > 35 ? "bad" : ""}><span>φ</span><b>{f(roll, 1)}</b><small>°</small></div>
            <div className={(aoa ?? 0) > 12 ? "bad" : ""}><span>α</span><b>{f(aoa, 1)}</b><small>°</small></div>
          </div>
        </div>
        <div className="label col-label">Voices · testimony</div>
        {voices.map((vc) => (
          <div key={vc.key} ref={regCard(vc.key, vc.zone, "l")} className={`card voice k-${vc.kind} ${selected?.item.id === vc.key ? "sel" : ""}`}
            onMouseEnter={() => { setHoverZone(vc.zone); if (vc.anomalyId) setHoverAn(vc.anomalyId); }}
            onMouseLeave={() => { setHoverZone(null); setHoverAn(null); }}
            onClick={() => onSelect(vc.sel)}>
            <div className="vhead"><span className="kind">{vc.kind}</span><span className="who">{vc.who}</span><span className="ft">{vc.t !== null ? fmtT(vc.t) : "untimed"}</span></div>
            <div className="vtext">“{vc.text.slice(0, 170)}{vc.text.length > 170 ? "…" : ""}”</div>
            <div className="vzone"><SourceTag g={g} atom={vc.atom} /> → {ZONES.find((z) => z.id === vc.zone)?.label.toLowerCase()}</div>
          </div>
        ))}
        {!voices.length && <div className="card dim">No crew / ATC / witness statements up to {fmtT(t)}</div>}
      </div>

      {/* right column: systems */}
      <div className="col right">
        {SYSTEM_CARDS.map(([z, label]) => {
          const d = zones[z];
          const n = d.anomalies.filter((a) => a.time?.t_s == null || a.time.t_s <= t).length;
          const last = [...d.events].reverse().find((e) => e.time.t_s !== null && e.time.t_s <= t) ?? null;
          return (
            <div key={z} ref={regCard(`sys-${z}`, z, "r")} className={`card sys ${alarmZones.has(z) ? "alarm" : ""} ${hoverZone === z ? "hl" : ""}`}
              onMouseEnter={() => setHoverZone(z)} onMouseLeave={() => setHoverZone(null)}>
              <div className="vhead"><i className={`led ${alarmZones.has(z) ? "red" : n ? "amber" : "green"}`} /><span className="kind">{label}</span><span className="who">{n ? `${n} anom` : ""}</span></div>
              <ZoneBody id={z} t={t} sm={sm} di={di} last={last} />
              {last && <div className="vzone">last: <SourceTag g={g} atom={last} /></div>}
            </div>
          );
        })}
      </div>

      {/* anomaly tags pinned to parts */}
      {tags.map((a) => {
        const zone = zoneOfAnomaly(a);
        const slot = tagSlots.get(zone) ?? 0;
        tagSlots.set(zone, slot + 1);
        const isHover = hoverAn === a.id;
        const partner = hoverAn && hoverAn !== a.id ? (links.get(hoverAn) ?? []).find((l) => l.other === a.id) : undefined;
        return (
          <div key={a.id} className={`tag sev-${a.severity} ${a.time?.t_s == null ? "latent" : ""} ${isHover ? "hover" : ""} ${partner ? "partner" : ""} ${t - (a.time?.t_s ?? -1e12) < 12 ? "fresh" : ""}`}
            ref={(el) => { if (el) tagEls.current.set(a.id, { el, zone, slot }); else tagEls.current.delete(a.id); }}
            onMouseEnter={() => { setHoverAn(a.id); setHoverZone(zone); }} onMouseLeave={() => { setHoverAn(null); setHoverZone(null); }}
            onClick={() => onSelect({ kind: "anomaly", item: a })}>
            <span className="dia">◆</span>{a.title.slice(0, 28)}
            {partner && <span className="rel">{partner.dir === "in" ? "cause" : "effect"} · {a.time?.t_s != null && anById.get(hoverAn!)?.time?.t_s != null ? dt(a.time.t_s - anById.get(hoverAn!)!.time!.t_s!) : "latent"}</span>}
            {isHover && (
              <div className="pop">
                <div className="ph"><b>{a.title}</b><span className="ft">{a.time?.t_s != null ? fmtT(a.time.t_s) : "latent condition"}</span></div>
                <div><SourceTag g={g} atom={a} long /> <span className="dim">{a.certainty}</span></div>
                <div className="pr"><span>expected</span>{a.expected}</div>
                <div className="pr"><span>observed</span>{a.observed}</div>
                {(links.get(a.id) ?? []).map((l) => {
                  const o = anById.get(l.other); if (!o) return null;
                  const d = o.time?.t_s != null && a.time?.t_s != null ? dt(o.time.t_s - a.time.t_s) : o.time?.t_s != null ? fmtT(o.time.t_s) : "latent";
                  return (
                    <div key={l.other} className="plink">
                      <span className="rl">{l.dir === "in" ? "result of" : l.relation.replace(/_/g, " ")}</span>
                      <b>{o.title}</b> <span className="ft">{d}</span>
                      <div className="dim">{l.rationale}</div>
                    </div>
                  );
                })}
                {!(links.get(a.id) ?? []).length && <div className="dim">No causal links yet</div>}
              </div>
            )}
          </div>
        );
      })}
      {!pts.length && <div className="empty">No ADS-B track or FDR altitude yet: aircraft shown at a reference position</div>}
    </div>
  );
}
