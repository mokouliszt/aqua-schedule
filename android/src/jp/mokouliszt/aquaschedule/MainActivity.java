//------------------------------------------------------------------------------
// 名古屋港水族館 イベントスケジュール ビューア
//
// WebView 上の SPA (assets/index.html) をホストし、公式サイトの
// 非公開 API へのアクセスをネイティブ HTTP ブリッジ経由で提供する。
// v1.2: デジタルマップ経路連携（階選択・現在地取得・外部ブラウザ起動）を追加。
//------------------------------------------------------------------------------
package jp.mokouliszt.aquaschedule;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * メインアクティビティ。
 *
 * <p>単一の WebView に単一ファイル化した SPA を読み込み、
 * {@code window.AquaBridge} として以下を公開する。</p>
 * <ul>
 *   <li>{@code fetchEventDetail} : イベントスケジュール API の代行取得</li>
 *   <li>{@code fetchUrl}         : 許可ドメインへの汎用 HTTP GET（Cookie 維持）</li>
 *   <li>{@code requestRouteContext} : 階選択ダイアログ + 現在地取得</li>
 *   <li>{@code openExternal}     : デジタルマップ URL の外部ブラウザ起動</li>
 * </ul>
 *
 * @author mokouliszt
 * @since 1.0.0
 */
public class MainActivity extends Activity {

    /** スケジュール取得 API のベース URL */
    private static final String API_BASE =
            "https://nagoyaaqua.jp/event_schedule_admin/public/get_event_detail";

    /** 汎用 fetch / 外部起動を許可するオリジン */
    private static final String[] ALLOWED_ORIGINS = {
            "https://nagoyaaqua.jp/",
            "https://nagoyaaqua.smartmap-pro.com/"
    };

    /** 通信タイムアウト [ms] */
    private static final int TIMEOUT_MS = 10000;

    /** 位置情報パーミッション要求コード */
    private static final int REQ_LOCATION = 100;

    /** マップのフロア一覧（表示順） */
    private static final String[] FLOORS = {"3F", "2F", "1F"};

    /** HTTP 実行用スレッドプール */
    private final ExecutorService executor = Executors.newFixedThreadPool(2);

    /** ホスト WebView */
    private WebView webView;

    /** 設定保存 */
    private SharedPreferences prefs;

    /** 位置情報許可待ちの経路コンテキスト要求 (コールバック ID) */
    private int pendingRouteId = -1;

    /** 位置情報許可待ちの選択済みフロア */
    private String pendingFloor = null;

    /** {@inheritDoc} */
    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // マップサイトのセッション Cookie をプロセス内で維持する
        if (!(CookieHandler.getDefault() instanceof CookieManager)) {
            CookieHandler.setDefault(new CookieManager(null, CookiePolicy.ACCEPT_ALL));
        }
        prefs = getSharedPreferences("aqua", MODE_PRIVATE);

        webView = new WebView(this);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new AquaBridge(), "AquaBridge");
        webView.setBackgroundColor(0xFFF2F7FA);

        setContentView(webView);
        webView.loadUrl("file:///android_asset/index.html");
    }

    /** {@inheritDoc} */
    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    /** {@inheritDoc} */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION || pendingRouteId < 0) {
            return;
        }
        int id = pendingRouteId;
        String floor = pendingFloor;
        pendingRouteId = -1;
        pendingFloor = null;
        resolveRouteContext(id, floor);
    }

    /**
     * JavaScript へ公開するブリッジ。
     */
    private class AquaBridge {

        /**
         * 指定日のイベント詳細 HTML フラグメントを取得する。
         *
         * @param id      JS 側コールバック識別子
         * @param dateKey 対象日 (yyyyMMdd)
         */
        @JavascriptInterface
        public void fetchEventDetail(final int id, final String dateKey) {
            if (dateKey == null || !dateKey.matches("\\d{8}")) {
                post(id, false, "不正な日付指定です");
                return;
            }
            httpGet(id, API_BASE + "?lang=ja&this_date=" + dateKey, false);
        }

        /**
         * 許可ドメインへの汎用 HTTP GET。マップのグラフデータ取得に使用する。
         *
         * @param id  JS 側コールバック識別子
         * @param url 取得先 URL（ALLOWED_ORIGINS 配下のみ許可）
         */
        @JavascriptInterface
        public void fetchUrl(final int id, final String url) {
            if (!isAllowed(url)) {
                post(id, false, "許可されていない URL です");
                return;
            }
            httpGet(id, url, true);
        }

        /**
         * 経路計算の事前情報（現在の階・現在地）を収集する。
         * 階選択はネイティブダイアログ、現在地は端末の位置情報を使用する。
         * 結果 JSON: {@code {"floor":"2F","lat":35.09,"lng":136.87}}（取得不可時は null）
         *
         * @param id JS 側コールバック識別子
         */
        @JavascriptInterface
        public void requestRouteContext(final int id) {
            runOnUiThread(() -> showFloorDialog(id));
        }

        /**
         * ネイティブの日付選択ダイアログを表示する。
         * WebView 標準の date ピッカーはクリア（削除）ボタンを含むため、
         * これを持たない {@link DatePickerDialog} で代替する。
         * 結果は yyyyMMdd 文字列、キャンセル時は ok=false で通知する。
         *
         * @param id      JS 側コールバック識別子
         * @param dateKey 初期表示日 (yyyyMMdd)
         */
        @JavascriptInterface
        public void pickDate(final int id, final String dateKey) {
            runOnUiThread(() -> showDatePicker(id, dateKey));
        }

        /**
         * デジタルマップ URL を外部ブラウザで開く。
         *
         * @param url 対象 URL（ALLOWED_ORIGINS 配下のみ許可）
         */
        @JavascriptInterface
        public void openExternal(final String url) {
            if (!isAllowed(url)) {
                return;
            }
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    // ブラウザ不在端末など。何もしない
                }
            });
        }
    }

    /**
     * ネイティブ日付選択ダイアログを表示する。
     *
     * @param id      JS 側コールバック識別子
     * @param dateKey 初期表示日 (yyyyMMdd)。不正な場合は本日
     */
    private void showDatePicker(final int id, final String dateKey) {
        Calendar cal = Calendar.getInstance();
        if (dateKey != null && dateKey.matches("\\d{8}")) {
            cal.set(Integer.parseInt(dateKey.substring(0, 4)),
                    Integer.parseInt(dateKey.substring(4, 6)) - 1,
                    Integer.parseInt(dateKey.substring(6, 8)));
        }
        DatePickerDialog dlg = new DatePickerDialog(this,
                (view, y, m, d) -> post(id, true,
                        String.format(Locale.US, "%04d%02d%02d", y, m + 1, d)),
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH),
                cal.get(Calendar.DAY_OF_MONTH));
        dlg.setOnCancelListener(d -> post(id, false, "cancelled"));
        dlg.show();
    }

    /**
     * フロア選択ダイアログを表示する。選択後に位置情報の取得へ進む。
     *
     * @param id JS 側コールバック識別子
     */
    private void showFloorDialog(final int id) {
        int last = prefs.getInt("lastFloorIndex", 1); // 既定 2F（入館フロア）
        final int[] selected = {last};
        new AlertDialog.Builder(this)
                .setTitle("現在いる階を選択")
                .setSingleChoiceItems(FLOORS, last, (d, which) -> selected[0] = which)
                .setPositiveButton("経路を表示", (d, w) -> {
                    prefs.edit().putInt("lastFloorIndex", selected[0]).apply();
                    proceedWithFloor(id, FLOORS[selected[0]]);
                })
                .setNegativeButton("キャンセル", (d, w) -> post(id, false, "cancelled"))
                .setOnCancelListener(d -> post(id, false, "cancelled"))
                .show();
    }

    /**
     * フロア確定後の処理。位置情報パーミッションを確認し、
     * 未許可なら要求してコールバックで継続する。
     *
     * @param id    JS 側コールバック識別子
     * @param floor 選択されたフロア
     */
    private void proceedWithFloor(int id, String floor) {
        if (hasLocationPermission()) {
            resolveRouteContext(id, floor);
        } else {
            pendingRouteId = id;
            pendingFloor = floor;
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }
    }

    /**
     * 位置情報パーミッションの有無を判定する。
     *
     * @return いずれかの位置情報権限が許可済みなら true
     */
    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 現在地（最終既知位置）を取得し、経路コンテキストを JS へ返す。
     * 位置が取得できない場合は lat/lng を null で返す（JS 側で入口起点に
     * フォールバックする）。
     *
     * @param id    JS 側コールバック識別子
     * @param floor 選択されたフロア
     */
    @SuppressLint("MissingPermission")
    private void resolveRouteContext(int id, String floor) {
        Double lat = null;
        Double lng = null;
        try {
            if (hasLocationPermission()) {
                LocationManager lm = getSystemService(LocationManager.class);
                Location best = null;
                for (String p : new String[]{LocationManager.GPS_PROVIDER,
                        LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER}) {
                    try {
                        Location l = lm.getLastKnownLocation(p);
                        if (l != null && (best == null || l.getTime() > best.getTime())) {
                            best = l;
                        }
                    } catch (IllegalArgumentException ignored) {
                        // プロバイダ非搭載端末
                    }
                }
                if (best != null) {
                    lat = best.getLatitude();
                    lng = best.getLongitude();
                }
            }
        } catch (Exception ignored) {
            // 位置取得失敗時は null のまま（入口フォールバック）
        }
        String json = "{\"floor\":\"" + floor + "\",\"lat\":" + lat + ",\"lng\":" + lng + "}";
        post(id, true, json);
    }

    /**
     * URL が許可オリジン配下か判定する。
     *
     * @param url 判定対象
     * @return 許可されていれば true
     */
    private static boolean isAllowed(String url) {
        if (url == null) {
            return false;
        }
        for (String origin : ALLOWED_ORIGINS) {
            if (url.startsWith(origin)) {
                return true;
            }
        }
        return false;
    }

    /**
     * HTTP GET を実行し、結果を JS へ通知する。
     *
     * @param id       JS 側コールバック識別子
     * @param urlStr   取得先 URL
     * @param jsonWant JSON API 向けヘッダ（Accept / XHR）を付与するか
     */
    private void httpGet(final int id, final String urlStr, final boolean jsonWant) {
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(TIMEOUT_MS);
                conn.setReadTimeout(TIMEOUT_MS);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent",
                        "Mozilla/5.0 (Linux; Android) AquaSchedule/1.2");
                if (jsonWant) {
                    conn.setRequestProperty("Accept", "application/json, text/plain, */*");
                    conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
                }
                int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    post(id, false, "HTTP " + code);
                    return;
                }
                post(id, true, readAll(conn.getInputStream()));
            } catch (Exception e) {
                post(id, false, "通信エラー: " + e.getClass().getSimpleName());
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    /**
     * 入力ストリームを末尾まで読み取り文字列化する。
     *
     * @param in 入力ストリーム
     * @return UTF-8 文字列
     * @throws Exception 入出力例外
     */
    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
        }
        return buf.toString(StandardCharsets.UTF_8.name());
    }

    /**
     * 結果を UI スレッドで JS 側コールバックへ通知する。
     *
     * @param id   コールバック識別子
     * @param ok   成否
     * @param body 本文
     */
    private void post(final int id, final boolean ok, final String body) {
        final String b64 = Base64.encodeToString(
                body.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.__aquaResolve(" + id + "," + ok + ",'" + b64 + "')", null));
    }
}
