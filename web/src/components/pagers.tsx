/**
 * ドラッグ追従ページャー
 *
 * DateStrip     : ヘッダーの日付を前日/当日/翌日の 3 ペイン無限ストリップで表示。
 *                 指に追従し、離した位置・速度でスナップ確定 or スプリングバック。
 * ContentPager  : イベント順/時刻順の 2 ペインを横並びトラックで保持し、
 *                 同様のドラッグ追従で切り替える（端はラバーバンド抵抗）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  attachHDrag,
  COMMIT_RATIO,
  COMMIT_VELOCITY,
  SNAP_TRANSITION,
} from "@/lib/drag"
import { addDays, keyToDate } from "@/lib/api"

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"]

/* ================================================================== */
/*  DateStrip                                                          */
/* ================================================================== */

export function DateStrip({
  dateKey,
  todayKey,
  onCommit,
  onOpenPicker,
  dragSurfaceRef,
}: {
  dateKey: string
  todayKey: string
  /** dir: +1 = 翌日 / -1 = 前日 */
  onCommit: (dir: 1 | -1) => void
  onOpenPicker: () => void
  /** ドラッグ受付面 (ヘッダー全体)。tablist は内部で除外する */
  dragSurfaceRef: React.RefObject<HTMLElement | null>
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const dateKeyRef = useRef(dateKey)
  dateKeyRef.current = dateKey
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const CENTER = "translate3d(-33.3333%,0,0)"

  // 日付確定時 (コミット後 / 今日ボタン / ピッカー): 無遷移で中央へスナップ
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    track.style.transition = "none"
    track.style.transform = CENTER
    void track.offsetHeight // reflow
    busyRef.current = false
  }, [dateKey])

  useEffect(() => {
    const surface = dragSurfaceRef.current
    const track = trackRef.current
    const wrap = wrapRef.current
    if (!surface || !track || !wrap) return
    return attachHDrag(
      surface,
      {
        onStart: () => {
          if (busyRef.current) return
          track.style.transition = "none"
        },
        onMove: (dx) => {
          if (busyRef.current) return
          track.style.transform = `translate3d(calc(-33.3333% + ${dx}px),0,0)`
        },
        onEnd: (dx, vx) => {
          if (busyRef.current) return
          const w = wrap.clientWidth || 1
          const commit =
            Math.abs(dx) > w * COMMIT_RATIO || Math.abs(vx) > COMMIT_VELOCITY
          const dir: 1 | -1 | 0 = commit ? (dx < 0 ? 1 : -1) : 0
          animateTo(dir)
        },
      },
      '[role="tablist"]'
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** dir 方向へスナップアニメーション → 確定。0 はスプリングバック */
  const animateTo = (dir: 1 | -1 | 0) => {
    const track = trackRef.current
    if (!track) return
    if (dir !== 0) busyRef.current = true
    track.style.transition = SNAP_TRANSITION
    track.style.transform =
      dir === 1
        ? "translate3d(-66.6667%,0,0)"
        : dir === -1
          ? "translate3d(0%,0,0)"
          : CENTER
    if (dir !== 0) {
      window.setTimeout(() => onCommitRef.current(dir), 265)
    }
  }

  const chevron = (dir: 1 | -1) => {
    if (busyRef.current) return
    animateTo(dir)
  }

  const pane = (key: string) => {
    const d = keyToDate(key)
    return (
      <div key={key} className="flex w-1/3 shrink-0 items-center justify-center">
        <button
          className="rounded-lg px-3 py-1 text-center transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          onClick={onOpenPicker}
          aria-label="日付を選択"
          tabIndex={key === dateKey ? 0 : -1}
        >
          <div className="text-2xl font-bold leading-tight tnum">
            {d.getMonth() + 1}月{d.getDate()}日
            <span className="ml-1.5 text-base font-semibold text-white/85">
              ({WEEKDAYS[d.getDay()]})
            </span>
          </div>
          <div className="text-[11px] text-white/70 tnum">
            {d.getFullYear()}年{key === todayKey && " ・ 今日"}
          </div>
        </button>
      </div>
    )
  }

  return (
    <div className="mt-2 flex items-center justify-between">
      <Button variant="glass" size="icon" aria-label="前の日" onClick={() => chevron(-1)}>
        <ChevronLeft className="h-5 w-5" />
      </Button>

      <div ref={wrapRef} className="min-w-0 flex-1 overflow-hidden">
        <div ref={trackRef} className="flex w-[300%] will-change-transform">
          {pane(addDays(dateKey, -1))}
          {pane(dateKey)}
          {pane(addDays(dateKey, 1))}
        </div>
      </div>

      <Button variant="glass" size="icon" aria-label="次の日" onClick={() => chevron(1)}>
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  )
}

/* ================================================================== */
/*  ContentPager                                                       */
/* ================================================================== */

export function ContentPager({
  view,
  onViewChange,
  eventPane,
  timePane,
}: {
  view: "event" | "time"
  onViewChange: (v: "event" | "time") => void
  eventPane: React.ReactNode
  timePane: React.ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const onChangeRef = useRef(onViewChange)
  onChangeRef.current = onViewChange
  // ドラッグ中/遷移中は両ペインを表示 (通常時は非アクティブ側を折りたたむ)
  const [engaged, setEngaged] = useState(false)
  const mountedRef = useRef(false)

  const base = (v: "event" | "time") =>
    v === "time" ? "translate3d(-50%,0,0)" : "translate3d(0%,0,0)"

  // 初期位置 (無遷移)
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    track.style.transition = "none"
    track.style.transform = base(viewRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // タブタップ等の外部切替もトラックアニメーションで表現
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    const track = trackRef.current
    if (!track) return
    setEngaged(true)
    track.style.transition = SNAP_TRANSITION
    track.style.transform = base(view)
    const t = window.setTimeout(() => setEngaged(false), 300)
    return () => window.clearTimeout(t)
  }, [view])

  useEffect(() => {
    const wrap = wrapRef.current
    const track = trackRef.current
    if (!wrap || !track) return
    return attachHDrag(wrap, {
      onStart: () => {
        setEngaged(true)
        track.style.transition = "none"
      },
      onMove: (dx) => {
        // 端ではラバーバンド抵抗
        const v = viewRef.current
        let d = dx
        if ((v === "event" && dx > 0) || (v === "time" && dx < 0)) d = dx / 3.5
        track.style.transform = `translate3d(calc(${v === "time" ? "-50%" : "0%"} + ${d}px),0,0)`
      },
      onEnd: (dx, vx) => {
        const w = wrap.clientWidth || 1
        const v = viewRef.current
        const commit =
          Math.abs(dx) > w * COMMIT_RATIO || Math.abs(vx) > COMMIT_VELOCITY
        let next: "event" | "time" = v
        if (commit) {
          if (dx < 0 && v === "event") next = "time"
          else if (dx > 0 && v === "time") next = "event"
        }
        track.style.transition = SNAP_TRANSITION
        track.style.transform = base(next)
        window.setTimeout(() => {
          if (next !== viewRef.current) onChangeRef.current(next)
          setEngaged(false)
        }, 270)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paneClass = (key: "event" | "time") =>
    "w-1/2 shrink-0 " + (!engaged && view !== key ? "h-0 overflow-hidden" : "")

  return (
    <div ref={wrapRef} className="overflow-hidden touch-pan-y">
      <div ref={trackRef} className="flex w-[200%] items-start will-change-transform">
        <div className={paneClass("event")} aria-hidden={view !== "event"}>
          {eventPane}
        </div>
        <div className={paneClass("time")} aria-hidden={view !== "time"}>
          {timePane}
        </div>
      </div>
    </div>
  )
}
