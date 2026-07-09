#!/usr/bin/env bash
#------------------------------------------------------------------------------
# 名港水族館スケジュール APK ビルドスクリプト（Gradle 不使用の手動ツールチェーン）
#
# 前提:
#   - JDK 11+ (javac)
#   - ANDROID_SDK に build-tools 35.0.0 / platforms;android-34 導入済み
#   - ../web で `npm run build` 済み (dist/index.html が存在すること)
#
# 注意: build-tools 34.0.0 の d8 (R8 8.2.2-dev) は本ソースの dex 化で
#       内部 NPE を起こすため 35.0.0 以降を使用すること。
#------------------------------------------------------------------------------
set -euo pipefail
SDK="${ANDROID_SDK:-$HOME/android-sdk}"
BT="$SDK/build-tools/35.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
cd "$(dirname "$0")"

mkdir -p assets
cp ../web/dist/index.html assets/index.html

rm -rf build && mkdir -p build/compiled build/gen build/classes
"$BT/aapt2" compile --dir res -o build/compiled/res.zip
"$BT/aapt2" link -o build/base.apk -I "$PLAT" \
    --manifest AndroidManifest.xml -A assets \
    --java build/gen build/compiled/res.zip --auto-add-overlay
javac --release 8 -classpath "$PLAT" -d build/classes \
    build/gen/jp/mokouliszt/aquaschedule/R.java \
    src/jp/mokouliszt/aquaschedule/MainActivity.java
"$BT/d8" --lib "$PLAT" --release --min-api 26 --output build \
    $(find build/classes -name "*.class")
(cd build && zip -q base.apk classes.dex)

# 署名鍵（未作成時のみデバッグ鍵を生成。リリース時は自前の鍵に差し替え）
if [ ! -f build/debug.keystore ]; then
    keytool -genkeypair -keystore build/debug.keystore -alias androiddebugkey \
        -storepass android -keypass android -keyalg RSA -keysize 2048 \
        -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk
"$BT/apksigner" sign --ks build/debug.keystore \
    --ks-pass pass:android --key-pass pass:android \
    --out build/AquaSchedule-v1.4.0.apk build/aligned.apk
"$BT/apksigner" verify build/AquaSchedule-v1.4.0.apk
echo "==> build/AquaSchedule-v1.4.0.apk"
