import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlarmClock,
  CalendarDays,
  Clock,
  LayoutList,
  Loader2,
  MapPin,
  Moon,
  Navigation,
  RotateCw,
  Timer,
  WifiOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { DateStrip, ContentPager } from "@/components/pagers"
import { computeRoute, openExternal, requestRouteContext } from "@/lib/route"
import {
  addDays,
  bridgeCall,
  getDaySchedule,
  timeToMinutes,
  toKey,
  type DaySchedule,
  type AquaEvent,
} from "@/lib/api"

/** タブ上の素早いスワイプ検出 (追従はコンテンツ側ページャーが担当) */
function useHSwipe(onLeft: () => void, onRight: () => void, threshold = 40) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null)
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return void (start.current = null)
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY, t: Date.now() }
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current
      start.current = null
      if (!s) return
      const t = e.changedTouches[0]
      const dx = t.clientX - s.x
      const dy = t.clientY - s.y
      const dt = Date.now() - s.t
      if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 700) {
        dx < 0 ? onLeft() : onRight()
      }
    },
  }
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "closed" }
  | { kind: "ok"; data: DaySchedule }

type ViewMode = "event" | "time"

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem("aqua.viewMode") === "time" ? "time" : "event"
  } catch {
    return "event"
  }
}

export default function App() {
  const [dateKey, setDateKey] = useState(() => toKey(new Date()))
  const [view, setViewState] = useState<ViewMode>(loadViewMode)
  const [state, setState] = useState<State>({ kind: "loading" })
  const [now, setNow] = useState(() => new Date())
  const dateInputRef = useRef<HTMLInputElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const reqRef = useRef(0)

  const load = useCallback(async (key: string) => {
    const req = ++reqRef.current
    setState({ kind: "loading" })
    try {
      const data = await getDaySchedule(key)
      if (req !== reqRef.current) return
      setState(data ? { kind: "ok", data } : { kind: "closed" })
    } catch (e) {
      if (req !== reqRef.current) return
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    load(dateKey)
  }, [dateKey, load])

  // 「次の回」ハイライト更新用に毎分時刻を進める
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const todayKey = toKey(now)
  const isToday = dateKey === todayKey
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const setView = (v: ViewMode) => {
    setViewState(v)
    try {
      localStorage.setItem("aqua.viewMode", v)
    } catch {
      /* WebView 設定によっては storage 不可。表示モードは揮発でよい */
    }
  }
  const switchView = (v: ViewMode) => {
    if (v !== view) setView(v)
  }

  const tabSwipe = useHSwipe(
    () => switchView("time"),
    () => switchView("event")
  )

  // イベント横断で「現時刻以降で最も早い開始時刻」を求める（当日のみ）
  const nextGlobal = useMemo(() => {
    if (!isToday || state.kind !== "ok") return null
    let best: number | null = null
    for (const ev of state.data.events)
      for (const t of ev.times) {
        const m = timeToMinutes(t)
        if (m !== null && m >= nowMin && (best === null || m < best)) best = m
      }
    return best
  }, [isToday, state, nowMin])

  /* ---- 館内マップ経路連携 ---- */
  const [toast, setToast] = useState<string | null>(null)
  const [routingPlace, setRoutingPlace] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = (msg: string, ms = 3200) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), ms)
  }

  const openMapRoute = async (place: string) => {
    if (routingPlace) return
    const ctx = await requestRouteContext()
    if (!ctx) return // 階選択キャンセル
    setRoutingPlace(place)
    try {
      const r = await computeRoute(place, ctx)
      if (r.usedFallbackStart) {
        showToast("現在地を取得できないため、入口からの経路を表示します")
      }
      openExternal(r.url)
    } catch (e) {
      showToast(e instanceof Error ? e.message : "経路を計算できませんでした")
    } finally {
      setRoutingPlace(null)
    }
  }

  // 時刻順ビュー: (時刻, イベント) に展開し時刻でグループ化
  const timeline = useMemo(() => {
    if (state.kind !== "ok") return []
    const groups = new Map<number, { time: string; items: AquaEvent[] }>()
    for (const ev of state.data.events)
      for (const t of ev.times) {
        const m = timeToMinutes(t)
        if (m === null) continue
        const g = groups.get(m) ?? { time: t, items: [] }
        g.items.push(ev)
        groups.set(m, g)
      }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([minutes, g]) => ({ minutes, ...g }))
  }, [state])

  const openPicker = async () => {
    // ネイティブ DatePickerDialog 優先（WebView 標準ピッカーの削除ボタン回避）
    if (window.AquaBridge?.pickDate) {
      try {
        const key = await bridgeCall((id) => window.AquaBridge!.pickDate!(id, dateKey))
        if (/^\d{8}$/.test(key)) setDateKey(key)
      } catch {
        /* キャンセル */
      }
      return
    }
    const el = dateInputRef.current
    if (!el) return
    // showPicker は Android WebView (Chromium) で利用可
    if (typeof el.showPicker === "function") el.showPicker()
    else el.click()
  }

  /* ---- ペイン共通部品 ---- */

  const nextLegend = isToday && nextGlobal !== null && (
    <span className="ml-2 inline-flex items-center gap-1">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" />
      次の回
    </span>
  )

  const sourceNote = (
    <p className="mt-6 text-center text-[11px] leading-relaxed text-muted-foreground">
      出典: 名古屋港水族館 公式サイト (nagoyaaqua.jp)
      <br />
      スケジュールは変更される場合があります。
    </p>
  )

  const statusNode =
    state.kind === "loading" ? (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-2">
                <Skeleton className="h-6 w-14 rounded-full" />
                <Skeleton className="h-6 w-14 rounded-full" />
                <Skeleton className="h-6 w-14 rounded-full" />
              </div>
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        ))}
      </div>
    ) : state.kind === "error" ? (
      <EmptyState
        icon={<WifiOff className="h-8 w-8" />}
        title="取得できませんでした"
        body={`スケジュールの取得中にエラーが発生しました。通信環境を確認して再試行してください。(${state.message})`}
        action={<Button onClick={() => load(dateKey)}>再試行</Button>}
      />
    ) : state.kind === "closed" ? (
      <EmptyState
        icon={<Moon className="h-8 w-8" />}
        title="スケジュールが公開されていません"
        body="この日は休館日か、イベントスケジュールがまだ公開されていない可能性があります。別の日付を選択してください。"
        action={
          !isToday ? <Button onClick={() => setDateKey(todayKey)}>今日に戻る</Button> : undefined
        }
      />
    ) : null

  const eventPane = (
    <div className="px-4 py-4">
      {state.kind !== "ok" ? (
        statusNode
      ) : (
        <>
          <p className="mb-3 px-1 text-xs text-muted-foreground">
            {state.data.events.length} 件のイベント
            {nextLegend}
          </p>
          <div className="space-y-3">
            {state.data.events.map((ev, i) => (
              <Card key={i} className="overflow-hidden">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-[15px]">{ev.name}</CardTitle>
                    {ev.duration && (
                      <Badge variant="secondary" className="shrink-0 gap-1 font-normal">
                        <Timer className="h-3 w-3" />
                        {ev.duration}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {ev.times.map((t) => {
                      const m = timeToMinutes(t)
                      const variant =
                        !isToday || m === null
                          ? "time"
                          : m === nextGlobal
                            ? "next"
                            : m < nowMin
                              ? "done"
                              : "time"
                      return (
                        <Badge key={t} variant={variant} className="px-3 py-1 text-[13px]">
                          {t}
                        </Badge>
                      )
                    })}
                  </div>
                  <PlaceRow
                    place={ev.place}
                    routing={routingPlace === ev.place}
                    onRoute={() => openMapRoute(ev.place)}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
          {sourceNote}
        </>
      )}
    </div>
  )

  const timePane = (
    <div className="px-4 py-4">
      {state.kind !== "ok" ? (
        statusNode
      ) : (
        <>
          <p className="mb-3 px-1 text-xs text-muted-foreground">
            {timeline.length} つの開始時刻・{timeline.reduce((n, g) => n + g.items.length, 0)} 回
            {nextLegend}
          </p>
          <div className="relative">
            {/* タイムラインレール */}
            <div className="absolute bottom-2 left-[68px] top-2 w-px bg-border" aria-hidden />
            <div className="space-y-5">
              {timeline.map((g) => {
                const status = !isToday
                  ? "plain"
                  : g.minutes === nextGlobal
                    ? "next"
                    : g.minutes < nowMin
                      ? "done"
                      : "plain"
                return (
                  <div key={g.minutes} className="relative flex gap-4">
                    {/* 時刻ラベル */}
                    <div
                      className={
                        "w-[52px] shrink-0 pt-2 text-right text-sm font-bold tnum " +
                        (status === "next"
                          ? "text-destructive"
                          : status === "done"
                            ? "text-muted-foreground/50"
                            : "text-foreground")
                      }
                    >
                      {g.time}
                      {status === "next" && (
                        <div className="mt-0.5 text-[10px] font-semibold text-destructive">
                          次の回
                        </div>
                      )}
                      {status === "done" && (
                        <div className="mt-0.5 text-[10px] font-medium">終了</div>
                      )}
                    </div>
                    {/* レール上のドット */}
                    <div className="relative w-0 shrink-0" aria-hidden>
                      <span
                        className={
                          "absolute -left-[5px] top-[15px] h-[11px] w-[11px] rounded-full border-2 border-background " +
                          (status === "next"
                            ? "bg-destructive ring-4 ring-destructive/20 animate-pulse"
                            : status === "done"
                              ? "bg-muted-foreground/40"
                              : "bg-primary")
                        }
                      />
                    </div>
                    {/* イベント */}
                    <div
                      className={
                        "min-w-0 flex-1 space-y-2 " + (status === "done" ? "opacity-55" : "")
                      }
                    >
                      {g.items.map((ev, i) => (
                        <Card
                          key={i}
                          className={status === "next" ? "border-destructive/40 shadow-md" : ""}
                        >
                          <CardContent className="p-3">
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-semibold leading-snug">{ev.name}</p>
                              {ev.duration && (
                                <Badge variant="secondary" className="shrink-0 gap-1 font-normal">
                                  <Timer className="h-3 w-3" />
                                  {ev.duration}
                                </Badge>
                              )}
                            </div>
                            <div className="mt-1.5">
                              <PlaceRow
                                place={ev.place}
                                compact
                                routing={routingPlace === ev.place}
                                onRoute={() => openMapRoute(ev.place)}
                              />
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          {sourceNote}
        </>
      )}
    </div>
  )

  return (
    <div className="min-h-dvh flex flex-col">
      {/* ---- header ---- */}
      <header
        ref={headerRef}
        className="header-ocean text-white safe-top sticky top-0 z-10 shadow-md touch-pan-y"
      >
        <div className="mx-auto max-w-xl px-4 pb-3 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium tracking-[0.18em] text-white/80">
              名古屋港水族館
            </p>
            <div className="flex items-center gap-1.5">
              {!isToday && (
                <Button variant="glass" size="sm" onClick={() => setDateKey(todayKey)}>
                  今日
                </Button>
              )}
              <Button
                variant="glass"
                size="icon"
                className="h-8 w-8"
                aria-label="日付を選択"
                onClick={openPicker}
              >
                <CalendarDays className="h-4 w-4" />
              </Button>
              <Button
                variant="glass"
                size="icon"
                className="h-8 w-8"
                aria-label="再読み込み"
                onClick={() => load(dateKey)}
              >
                <RotateCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* 日付ストリップ (指追従ドラッグ + スナップ) */}
          <DateStrip
            dateKey={dateKey}
            todayKey={todayKey}
            onCommit={(dir) => setDateKey((k) => addDays(k, dir))}
            onOpenPicker={openPicker}
            dragSurfaceRef={headerRef}
          />

          {state.kind === "ok" && (
            <div className="mt-2.5 flex items-center justify-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 backdrop-blur-sm">
                <Clock className="h-3.5 w-3.5" />
                営業時間 <span className="font-semibold tnum">{state.data.hours}</span>
              </span>
            </div>
          )}
          {state.kind === "ok" && state.data.note && (
            <p className="mt-1.5 text-center text-[11px] text-white/70">{state.data.note}</p>
          )}

          {/* 表示モード切替（スライドインジケーター + スワイプ対応） */}
          <div
            className="relative mx-auto mt-3 grid w-full max-w-[260px] grid-cols-2 rounded-lg bg-white/15 p-1 backdrop-blur-sm touch-pan-y"
            role="tablist"
            aria-label="表示モード"
            onTouchStart={tabSwipe.onTouchStart}
            onTouchEnd={tabSwipe.onTouchEnd}
          >
            <span
              aria-hidden
              className={
                "pointer-events-none absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded-md bg-white shadow-sm transition-transform duration-200 ease-out " +
                (view === "time" ? "translate-x-full" : "translate-x-0")
              }
            />
            {(
              [
                { key: "event", label: "イベント順", icon: <LayoutList className="h-3.5 w-3.5" /> },
                { key: "time", label: "時刻順", icon: <AlarmClock className="h-3.5 w-3.5" /> },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={view === t.key}
                onClick={() => switchView(t.key)}
                className={
                  "relative z-[1] inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 " +
                  (view === t.key ? "text-primary" : "text-white/80 hover:text-white")
                }
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* ネイティブ日付ピッカー（不可視） */}
          <input
            ref={dateInputRef}
            type="date"
            required
            className="sr-only"
            value={`${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`}
            onChange={(e) => {
              if (e.target.value) setDateKey(e.target.value.replaceAll("-", ""))
            }}
          />
        </div>
      </header>

      {/* ---- body (2 ペイン ドラッグ追従ページャー) ---- */}
      <main className="mx-auto w-full max-w-xl flex-1 safe-bottom">
        <ContentPager
          view={view}
          onViewChange={switchView}
          eventPane={eventPane}
          timePane={timePane}
        />
      </main>

      {/* ---- toast ---- */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-6">
          <div className="max-w-md rounded-lg bg-foreground/90 px-4 py-2.5 text-center text-[13px] font-medium text-background shadow-lg backdrop-blur-sm">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}

function PlaceRow({
  place,
  onRoute,
  routing,
  compact,
}: {
  place: string
  onRoute: () => void
  routing: boolean
  compact?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div
        className={
          "flex min-w-0 items-center gap-1.5 text-muted-foreground " +
          (compact ? "text-[13px]" : "text-sm")
        }
      >
        <MapPin className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span className="truncate">{place}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 px-2.5 text-xs text-primary"
        disabled={routing}
        onClick={onRoute}
        aria-label={`${place} への経路をマップで表示`}
      >
        {routing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Navigation className="h-3.5 w-3.5" />
        )}
        マップ
      </Button>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}) {
  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-primary">
          {icon}
        </div>
        <p className="font-semibold">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        {action}
      </CardContent>
    </Card>
  )
}
