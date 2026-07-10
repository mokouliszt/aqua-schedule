# 名港水族館スケジュール (AquaSchedule)

<p align="center">
  <img src="docs/icon.png" alt="AquaSchedule アイコン" width="128">
</p>

名古屋港水族館の公式サイトから、指定日のイベント
スケジュールを取得して表示する Android アプリ。起動時は当日のスケジュールを表示する。

## API 仕様

公式カレンダーページ https://nagoyaaqua.jp/calendar/ の日付クリック時に呼ばれる:

```
GET https://nagoyaaqua.jp/event_schedule_admin/public/get_event_detail?lang=ja&this_date=YYYYMMDD
```

- 応答: `<div class="event-modal__inner">…</div>` の HTML フラグメント
  - `h2` 内に日付・曜日・営業時間・注記
  - `tbody tr` にイベント名（末尾に `（○分）` の所要時間）/ 開始時間（`/` 区切り）/ 観覧場所
- 休館日・未公開日は文字列 `false` を返す
- 月カレンダー用に `generate_month_calendar` (同パラメータ) も存在する

## アーキテクチャ

```
┌────────────────────────────────────────────────┐
│ Android (Java, Gradle 不使用)                    │
│  MainActivity                                   │
│   ├ WebView ── assets/index.html (単一ファイルSPA) │
│   └ AquaBridge (@JavascriptInterface)           │
│        │ fetchEventDetail(id, yyyyMMdd)         │
│        ▼ HttpURLConnection (バックグラウンド実行)   │
│      nagoyaaqua.jp ── 結果を Base64 化して        │
│                 window.__aquaResolve(id,ok,b64) │
└────────────────────────────────────────────────┘
```

- WebView は `file:///android_asset/` から読み込むため、公式 API への直接 fetch は
  CORS で遮断される。ネイティブ HTTP ブリッジで代行し、Base64 受け渡しで
  エスケープ問題を回避。
- SPA 側 (`web/src/lib/api.ts`) はブリッジ不在時（ブラウザ開発時）は直接 fetch に
  フォールバックする。

## Web フロントエンド (`web/`)

- Vite + React + TypeScript + Tailwind CSS
- shadcn/ui コンポーネント (Button / Card / Badge / Skeleton) を手動導入
  （CSS 変数トークンはアイコン画像由来のオーシャンブルーに調整）
- `vite-plugin-singlefile` で JS/CSS を単一 `dist/index.html` にインライン化
- 機能:
  - 初期表示は当日。前日/翌日ボタン、ネイティブ日付ピッカー (`showPicker()`)、「今日」ボタン
  - 当日表示時は「次の回」を赤バッジ+パルスでハイライト、終了回は打ち消し表示（毎分更新）
  - ローディングスケルトン / 休館日・通信エラーの空状態
- 開発: `cd web && npm install && npm run dev`
- ビルド: `npm run build` → `dist/index.html`

## Android (`android/`)

- Gradle 不使用の手動ツールチェーン: aapt2 → javac → d8 → zipalign → apksigner
- minSdk 26 / targetSdk 34 / パッケージ `jp.mokouliszt.aquaschedule`
- アダプティブアイコン対応 (`mipmap-anydpi-v26` + 各密度 PNG)
- ビルド: `./build.sh`（`ANDROID_SDK` 環境変数で SDK パス指定可）
- **既知の問題**: build-tools **34.0.0** 同梱の d8 (R8 8.2.2-dev) は本ソースの
  dex 化時に内部 NullPointerException を起こす。**35.0.0 以降を使用**すること。

## 注意事項

非公開 API のため、サイト改修で予告なく動かなくなる可能性があります。

## デジタルマップ経路連携 (v1.2)

イベントカードの「マップ」ボタンから、名古屋港水族館デジタルマップ
(nagoyaaqua.smartmap-pro.com / SmartMap Pro) に**経路を表示した状態で**
外部ブラウザを起動する。

### 仕組み（調査結果）

マップ SPA の経路計算はサーバ API ではなく、グラフデータ

```
GET https://nagoyaaqua.smartmap-pro.com/ajax/parcels/1/graph/ja
```

（要セッション Cookie + `X-Requested-With: XMLHttpRequest`。303 ノード・356 リンク・
スポット紐付け 46 ノード）に対する**クライアントサイド Dijkstra**
（コスト = distance + weight、is_one_way 対応）で行われる。さらにフロア跨ぎ遷移用に

```
?openFloorDirection=true&paths=<URIエンコードJSON>&nextPathIndex=0&from=<ノードJSON>&to=<ノードJSON>&accessibility=false
```

で経路描画状態を完全復元できる（`initFromURLParams`）。本アプリは同一の
Dijkstra とセグメント分割（type 2/4 = 階段/EV ノードで区切り）をアプリ内で再現し、
経路込み URL を生成して `ACTION_VIEW` でブラウザを開く。
**このためブラウザ側での位置情報許可・フロア選択は一切不要になる。**

### フロー

1. 「マップ」タップ → ネイティブの階選択ダイアログ（3F/2F/1F、前回値を記憶）
2. 位置情報パーミッション要求（初回のみ）→ LocationManager の最終既知位置を取得
3. JS 側でグラフ取得（Cookie はネイティブ CookieManager が維持。未確立なら
   マップページを先に GET して再試行）
4. 観覧場所文字列（例「南館 1F・赤道の海（サンゴ礁大水槽）」）を NFKC 正規化 +
   トークン分割し、スポットノードの title/フロア/館でスコアマッチング
5. 出発地 = 選択フロア上の最寄りノード。GPS 不可または館中心から 400m 以遠は
   入口（北館2F入口）フォールバック（トースト通知）
6. Dijkstra → セグメント分割 → URL 生成 → 外部ブラウザ起動

### セキュリティ

`fetchUrl` / `openExternal` は nagoyaaqua.jp / nagoyaaqua.smartmap-pro.com
配下のみ許可するホワイトリスト制。
