/**
 * 名古屋港水族館 イベントスケジュール取得レイヤ
 *
 * Android WebView 上では Java ブリッジ (window.AquaBridge) 経由で
 * ネイティブ HTTP を使い CORS を回避する。ブラウザ開発時は直接 fetch。
 */

export interface AquaEvent {
  name: string
  duration: string | null
  times: string[]
  place: string
}

export interface DaySchedule {
  dateLabel: string // 2026.7.9
  weekday: string // (木)
  hours: string // 9:30~17:30
  note: string // （入館は閉館時間の1時間前まで）
  events: AquaEvent[]
}

declare global {
  interface Window {
    AquaBridge?: {
      fetchEventDetail: (id: number, dateKey: string) => void
      fetchUrl?: (id: number, url: string) => void
      requestRouteContext?: (id: number) => void
      pickDate?: (id: number, dateKey: string) => void
      openExternal?: (url: string) => void
    }
    __aquaResolve: (id: number, ok: boolean, b64: string) => void
  }
}

const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>()
let seq = 0

/** ネイティブブリッジの非同期呼び出しを Promise 化する共通ヘルパ */
export function bridgeCall(invoke: (id: number) => void, timeoutMs = 30000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    invoke(id)
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error("タイムアウトしました"))
    }, timeoutMs)
  })
}

// Java 側からの非同期コールバック受け口（base64 で受けてエスケープ問題を回避）
window.__aquaResolve = (id, ok, b64) => {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const text = new TextDecoder("utf-8").decode(bytes)
    ok ? p.resolve(text) : p.reject(new Error(text))
  } catch (e) {
    p.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

const ENDPOINT =
  "https://nagoyaaqua.jp/event_schedule_admin/public/get_event_detail"

async function fetchRaw(dateKey: string): Promise<string> {
  if (window.AquaBridge) {
    return bridgeCall((id) => window.AquaBridge!.fetchEventDetail(id, dateKey), 15000)
  }
  // ブラウザ開発用フォールバック（CORS 制限あり）
  const res = await fetch(`${ENDPOINT}?lang=ja&this_date=${dateKey}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/** 公開されていない日（休館日等）は API が文字列 "false" を返す */
export async function getDaySchedule(dateKey: string): Promise<DaySchedule | null> {
  const raw = (await fetchRaw(dateKey)).trim()
  if (raw === "" || raw === "false") return null
  return parseFragment(raw)
}

function parseFragment(html: string): DaySchedule {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const txt = (sel: string) =>
    doc.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? ""

  const events: AquaEvent[] = []
  doc.querySelectorAll("tbody tr").forEach((tr) => {
    const tds = tr.querySelectorAll("td")
    if (tds.length < 3) return
    // SP 用の <small> ラベルを除去してからテキスト化
    tds.forEach((td) => td.querySelectorAll("small").forEach((s) => s.remove()))
    const rawName = tds[0].textContent?.replace(/\s+/g, " ").trim() ?? ""
    const m = rawName.match(/[（(]([^（）()]*分[^（）()]*)[）)]\s*$/)
    events.push({
      name: m ? rawName.slice(0, m.index).trim() : rawName,
      duration: m ? m[1] : null,
      times: (tds[1].textContent ?? "")
        .split("/")
        .map((t) => t.trim())
        .filter(Boolean),
      place: tds[2].textContent?.replace(/\s+/g, " ").trim() ?? "",
    })
  })

  return {
    dateLabel: txt(".event-modal__date"),
    weekday: txt(".event-modal__w"),
    hours: txt(".event-modal__time"),
    note: txt(".event-modal__note"),
    events,
  }
}

/* ---- date helpers ---- */

export function toKey(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`
}

export function keyToDate(key: string): Date {
  return new Date(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8))
}

export function addDays(key: string, n: number): string {
  const d = keyToDate(key)
  d.setDate(d.getDate() + n)
  return toKey(d)
}

/** "11:00" → 当日内の分。selected が今日のときの時刻状態判定に使う */
export function timeToMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})/)
  return m ? +m[1] * 60 + +m[2] : null
}
