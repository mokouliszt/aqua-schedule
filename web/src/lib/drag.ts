/**
 * 水平ドラッグジェスチャー (ネイティブリスナー / 非パッシブ)
 *
 * - 8px 移動時点で軸ロック: 水平優位なら preventDefault で縦スクロールを止めて
 *   ドラッグ追従、垂直優位ならブラウザのスクロールに委ねる
 * - 速度は指数移動平均 [px/ms]
 */
export interface HDragCallbacks {
  /** 水平ドラッグ確定時 (軸ロック成立) */
  onStart?: () => void
  /** ドラッグ中 (dx = 開始点からの水平移動量 px) */
  onMove: (dx: number) => void
  /** 指を離した (dx: 最終移動量, vx: 速度 px/ms。キャンセル時は 0,0) */
  onEnd: (dx: number, vx: number) => void
}

export function attachHDrag(
  el: HTMLElement,
  cb: HDragCallbacks,
  excludeSelector?: string
): () => void {
  let sx = 0
  let sy = 0
  let mode: "none" | "h" | "v" | "skip" = "skip"
  let lastX = 0
  let lastT = 0
  let vx = 0

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      mode = "skip"
      return
    }
    const target = e.target as Element | null
    if (excludeSelector && target?.closest(excludeSelector)) {
      mode = "skip"
      return
    }
    const t = e.touches[0]
    sx = lastX = t.clientX
    sy = t.clientY
    lastT = performance.now()
    vx = 0
    mode = "none"
  }

  const onTouchMove = (e: TouchEvent) => {
    if (mode === "skip" || mode === "v") return
    const t = e.touches[0]
    const dx = t.clientX - sx
    const dy = t.clientY - sy
    if (mode === "none") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? "h" : "v"
      if (mode === "h") cb.onStart?.()
      else return
    }
    // 水平ドラッグ中: 縦スクロールを抑止して追従
    e.preventDefault()
    const now = performance.now()
    const dt = now - lastT
    if (dt > 0) vx = ((t.clientX - lastX) / dt) * 0.6 + vx * 0.4
    lastX = t.clientX
    lastT = now
    cb.onMove(dx)
  }

  const onTouchEnd = (e: TouchEvent) => {
    if (mode === "h") {
      const t = e.changedTouches[0]
      // 静止してから離した場合はフリックとして扱わない
      const stale = performance.now() - lastT > 100
      cb.onEnd(t.clientX - sx, stale ? 0 : vx)
    }
    mode = "skip"
  }

  const onTouchCancel = () => {
    if (mode === "h") cb.onEnd(0, 0)
    mode = "skip"
  }

  el.addEventListener("touchstart", onTouchStart, { passive: true })
  el.addEventListener("touchmove", onTouchMove, { passive: false })
  el.addEventListener("touchend", onTouchEnd)
  el.addEventListener("touchcancel", onTouchCancel)
  return () => {
    el.removeEventListener("touchstart", onTouchStart)
    el.removeEventListener("touchmove", onTouchMove)
    el.removeEventListener("touchend", onTouchEnd)
    el.removeEventListener("touchcancel", onTouchCancel)
  }
}

/** スナップ用イージング */
export const SNAP_TRANSITION = "transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1)"
/** 確定判定: ペイン幅比の閾値 */
export const COMMIT_RATIO = 0.3
/** 確定判定: フリック速度閾値 [px/ms] */
export const COMMIT_VELOCITY = 0.45
