/**
 * 名古屋港水族館 デジタルマップ (SmartMap Pro) 経路連携
 *
 * 仕組み: マップ SPA はグラフ (/ajax/parcels/1/graph/ja) をクライアント側
 * Dijkstra で経路計算し、`?paths=...&from=...&to=...` のクエリで経路描画
 * 状態を復元できる(フロア跨ぎ遷移に使われる内部仕様)。本モジュールは
 * 同じ計算をアプリ内で再現し、経路表示済み URL を生成して外部ブラウザで開く。
 * これによりブラウザ側の位置情報許可は一切不要になる。
 */

const MAP_ORIGIN = "https://nagoyaaqua.smartmap-pro.com"
const MAP_PAGE = `${MAP_ORIGIN}/maps/574bp3oN/parcels/1/ja`
const GRAPH_URL = `${MAP_ORIGIN}/ajax/parcels/1/graph/ja`

interface GraphNode {
  id: number
  name: string
  location_id: number | null
  type: number // 2/4 = フロア間遷移ノード(階段/EV)
  layer_id: number
  coordinates: [string, string] // [lng, lat] 文字列(本家仕様のまま扱う)
  [k: string]: unknown
}
interface GraphLink {
  source: number
  target: number
  distance: string
  weight: number
  is_one_way: number
}
interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
  relatedLayers: { id: number; title: string }[]
  relatedLocations: { properties: { id: number; title: string; sub_title: string | null } }[]
}

export interface RouteContext {
  floor: "1F" | "2F" | "3F"
  lat: number | null
  lng: number | null
}

export interface RouteResult {
  url: string
  destTitle: string
  usedFallbackStart: boolean // GPS 不可/圏外で入口起点にフォールバックしたか
}


/* ---- bridge plumbing (api.ts と同じ __aquaResolve コールバックを共用) ---- */

import { bridgeCall } from "./api"

let graphCache: Graph | null = null

async function fetchGraph(): Promise<Graph> {
  if (graphCache) return graphCache
  const get = async (url: string) =>
    window.AquaBridge?.fetchUrl
      ? bridgeCall((id) => window.AquaBridge!.fetchUrl!(id, url))
      : (await fetch(url, { headers: { Accept: "application/json" } })).text()

  let body = await get(GRAPH_URL)
  if (!body.trimStart().startsWith("{")) {
    // セッション Cookie 未取得 (SmartPR エラーページ)。マップページで Cookie を確立して再試行
    await get(MAP_PAGE)
    body = await get(GRAPH_URL)
  }
  if (!body.trimStart().startsWith("{")) throw new Error("マップデータを取得できませんでした")
  graphCache = JSON.parse(body) as Graph
  return graphCache
}

/** ネイティブに階選択 + 現在地取得を依頼。ユーザーキャンセル時は null */
export async function requestRouteContext(): Promise<RouteContext | null> {
  if (!window.AquaBridge?.requestRouteContext) {
    // ブラウザ開発用: 2F 固定 + geolocation
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ floor: "2F", lat: null, lng: null })
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ floor: "2F", lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve({ floor: "2F", lat: null, lng: null }),
        { timeout: 4000 }
      )
    })
  }
  try {
    const json = await bridgeCall((id) => window.AquaBridge!.requestRouteContext!(id))
    return JSON.parse(json) as RouteContext
  } catch {
    return null // キャンセル
  }
}

/* ---- 目的地マッチング ---- */

const norm = (s: string) => s.normalize("NFKC").replace(/[\s\u3000]/g, "")

/** 観覧場所文字列 → { hall, floor, tokens } 例: "南館 1F・赤道の海（サンゴ礁大水槽）" */
function parsePlace(place: string) {
  const n = norm(place)
  const hall = n.includes("北館") ? "北館" : n.includes("南館") ? "南館" : null
  const fm = n.match(/([123])F/i)
  const floor = fm ? (`${fm[1]}F` as RouteContext["floor"]) : null
  const stripped = n.replace(/[北南]館/g, "").replace(/[123]F/gi, "")
  const tokens = stripped
    .split(/[・()（）,、]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  return { hall, floor, tokens }
}

/** 観覧場所 → 目的地ノード。マッチしなければ null */
function matchDestination(g: Graph, place: string): { node: GraphNode; title: string } | null {
  const { hall, floor, tokens } = parsePlace(place)
  const layerTitle = new Map(g.relatedLayers.map((l) => [l.id, norm(l.title)]))
  const locById = new Map(g.relatedLocations.map((l) => [l.properties.id, l.properties]))

  let best: { node: GraphNode; title: string; score: number } | null = null
  for (const node of g.nodes) {
    if (!node.location_id) continue
    const loc = locById.get(node.location_id)
    if (!loc) continue
    const title = norm(loc.title)
    const sub = norm(loc.sub_title ?? "")
    let score = 0
    for (const t of tokens) {
      if (title.includes(t)) score = Math.max(score, t.length * 10)
      else if (t.includes(title.replace(/\(.*?\)/g, ""))) score = Math.max(score, 5)
    }
    if (score === 0) continue
    if (floor && layerTitle.get(node.layer_id) === floor) score += 8
    if (hall && sub.includes(hall)) score += 3
    if (!best || score > best.score) best = { node, title: loc.title, score }
  }
  return best ? { node: best.node, title: best.title } : null
}

/* ---- 出発地決定 ---- */

const AQUA_CENTER = { lng: 136.87808, lat: 35.09118 }
const MAX_DIST_M = 400 // これ以遠の GPS は圏外とみなし入口フォールバック

function distM(aLng: number, aLat: number, bLng: number, bLat: number) {
  const kx = 111320 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180))
  const ky = 110540
  return Math.hypot((aLng - bLng) * kx, (aLat - bLat) * ky)
}

function findStart(g: Graph, ctx: RouteContext): { node: GraphNode; fallback: boolean } {
  const layer = g.relatedLayers.find((l) => norm(l.title) === ctx.floor)
  if (ctx.lat != null && ctx.lng != null && layer) {
    const inRange = distM(ctx.lng, ctx.lat, AQUA_CENTER.lng, AQUA_CENTER.lat) <= MAX_DIST_M
    if (inRange) {
      let bestNode: GraphNode | null = null
      let bestD = Infinity
      for (const n of g.nodes) {
        if (n.layer_id !== layer.id) continue
        const d = distM(ctx.lng, ctx.lat, +n.coordinates[0], +n.coordinates[1])
        if (d < bestD) {
          bestD = d
          bestNode = n
        }
      }
      if (bestNode) return { node: bestNode, fallback: false }
    }
  }
  // フォールバック: 入口 (北館2F入口) → 見つからなければ選択フロアの先頭ノード
  const locById = new Map(g.relatedLocations.map((l) => [l.properties.id, l.properties]))
  const entrance = g.nodes.find(
    (n) => n.location_id && locById.get(n.location_id)?.title.includes("入口")
  )
  return { node: entrance ?? g.nodes.find((n) => n.layer_id === layer?.id) ?? g.nodes[0], fallback: true }
}

/* ---- Dijkstra (本家 app.js と同一コスト: distance + weight) ---- */

function shortestPath(g: Graph, fromId: number, toId: number): number[] | null {
  const idx = new Map(g.nodes.map((n, i) => [n.id, i]))
  const N = g.nodes.length
  const adj: [number, number][][] = Array.from({ length: N }, () => [])
  for (const l of g.links) {
    const s = idx.get(l.source)
    const t = idx.get(l.target)
    if (s == null || t == null) continue
    const w = parseFloat(l.distance) + l.weight
    adj[s].push([t, w])
    if (!l.is_one_way) adj[t].push([s, w])
  }
  const src = idx.get(fromId)
  const dst = idx.get(toId)
  if (src == null || dst == null) return null
  const dist = new Array<number>(N).fill(Infinity)
  const prev = new Array<number>(N).fill(-1)
  const done = new Array<boolean>(N).fill(false)
  dist[src] = 0
  for (;;) {
    let u = -1
    let du = Infinity
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < du) ((du = dist[i]), (u = i))
    if (u < 0 || u === dst) break
    done[u] = true
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) ((dist[v] = dist[u] + w), (prev[v] = u))
  }
  if (dist[dst] === Infinity) return null
  const path: number[] = []
  for (let u = dst; u !== -1; u = prev[u]) path.push(g.nodes[u].id)
  return path.reverse()
}

/** 本家 findPath と同じセグメント分割 (type 2/4 = 階移動ノードで区切る) */
function buildPaths(g: Graph, nodeIds: number[]) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const segs: { layer_id: number; coordinates: [string, string][]; node_ids: number[] }[] = []
  const first = byId.get(nodeIds[0])!
  let layer = first.layer_id
  let coords: [string, string][] = [first.coordinates]
  let ids = [first.id]
  for (let i = 1; i < nodeIds.length; i++) {
    const e = byId.get(nodeIds[i])!
    coords.push(e.coordinates)
    ids.push(e.id)
    if (i === nodeIds.length - 1) {
      segs.push({ layer_id: layer, coordinates: coords, node_ids: ids })
      break
    }
    if (e.type === 2 || e.type === 4) {
      segs.push({ layer_id: layer, coordinates: coords, node_ids: ids })
      i += 1
      const nxt = byId.get(nodeIds[i])!
      layer = nxt.layer_id
      coords = [nxt.coordinates]
      ids = [nxt.id]
    }
  }
  return segs
}

/* ---- public API ---- */

/** 観覧場所への経路 URL を計算する。目的地不明・経路なしは Error を投げる */
export async function computeRoute(place: string, ctx: RouteContext): Promise<RouteResult> {
  const g = await fetchGraph()
  const dest = matchDestination(g, place)
  if (!dest) throw new Error("マップ上の目的地を特定できませんでした")
  const start = findStart(g, ctx)
  const path = shortestPath(g, start.node.id, dest.node.id)
  if (!path) throw new Error("経路が見つかりませんでした")
  const segs = buildPaths(g, path)
  const from = { ...start.node, name: start.fallback ? "入口" : "現在地" }
  const q =
    "openFloorDirection=true" +
    "&paths=" + encodeURIComponent(JSON.stringify(segs)) +
    "&nextPathIndex=0" +
    "&from=" + encodeURIComponent(JSON.stringify(from)) +
    "&to=" + encodeURIComponent(JSON.stringify(dest.node)) +
    "&accessibility=false"
  return { url: `${MAP_PAGE}?${q}`, destTitle: dest.title, usedFallbackStart: start.fallback }
}

export function openExternal(url: string) {
  if (window.AquaBridge?.openExternal) window.AquaBridge.openExternal(url)
  else window.open(url, "_blank")
}
