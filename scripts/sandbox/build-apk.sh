#!/bin/bash
# Hark-sandbox APK build (Linux aarch64 behind an authenticated HTTPS proxy).
# Installs JDK 21 + Android SDK into ~/tools if missing, then builds and copies
# the APK to dist-apk/dairy-diary.apk.   Usage:  bash scripts/sandbox/build-apk.sh
# Gradle is run detached (sandbox commands time out at 120 s); poll /tmp/gradle-build.log
# for "EXIT 0", then run:  bash scripts/sandbox/build-apk.sh --copy
set -e
PROJ="$(cd "$(dirname "$0")/../.." && pwd)"
T=$HOME/tools; mkdir -p $T
if [ "$1" = "--copy" ]; then
  grep -q "EXIT 0" /tmp/gradle-build.log && mkdir -p "$PROJ/dist-apk" && cp "$PROJ/android/app/build/outputs/apk/debug/app-debug.apk" "$PROJ/dist-apk/dairy-diary.apk" && ls -la "$PROJ/dist-apk"; exit
fi
ARCH=$(uname -m); [ "$ARCH" = aarch64 ] && JA=aarch64 || JA=x64
# 1. local no-auth proxy in front of the sandbox proxy (Java/sdkmanager cannot do proxy auth)
cp "$PROJ/scripts/sandbox/authproxy.py" $T/authproxy.py
pgrep -f authproxy.py >/dev/null || (cd $T && setsid nohup python3 authproxy.py >/tmp/authproxy.log 2>&1 </dev/null &)
sleep 1
# 2. JDK 21
if ! ls -d $T/jdk-21* >/dev/null 2>&1; then
  curl -sSL -o /tmp/jdk.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/linux/$JA/jdk/hotspot/normal/eclipse"
  tar xzf /tmp/jdk.tar.gz -C $T
fi
export JAVA_HOME=$(ls -d $T/jdk-21* | head -1) ANDROID_HOME=$T/android-sdk ANDROID_SDK_ROOT=$T/android-sdk
export PATH=$JAVA_HOME/bin:$PATH
# 3. truststore with the sandbox CA bundle
TS=$T/truststore.jks
if [ ! -f $TS ]; then
  cp $JAVA_HOME/lib/security/cacerts $TS; chmod u+w $TS
  rm -rf /tmp/certs; mkdir /tmp/certs; (cd /tmp/certs && csplit -s -z -f c "${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}" '/-----BEGIN CERTIFICATE-----/' '{*}')
  for f in /tmp/certs/c*; do keytool -importcert -noprompt -keystore $TS -storepass changeit -alias "x$(basename $f)" -file $f >/dev/null 2>&1 || true; done
fi
# 4. Android SDK
if [ ! -d $ANDROID_HOME/platforms/android-36 ]; then
  mkdir -p $ANDROID_HOME/cmdline-tools
  curl -sSL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  (cd $ANDROID_HOME/cmdline-tools && rm -rf latest cmdline-tools && unzip -q /tmp/cmdtools.zip && mv cmdline-tools latest)
  export SDKMANAGER_OPTS="-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=8899 -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=8899 -Djavax.net.ssl.trustStore=$TS -Djavax.net.ssl.trustStorePassword=changeit"
  export HTTPS_PROXY=http://127.0.0.1:8899 HTTP_PROXY=http://127.0.0.1:8899
  yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null 2>&1 || true
  yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;35.0.0" "build-tools;36.0.0" >/dev/null
fi
# 5. Google ships x86-64-only build tools; on ARM swap in static aarch64 builds (lzhiyong/android-sdk-tools)
if [ "$ARCH" = aarch64 ] && ! file $ANDROID_HOME/build-tools/36.0.0/aapt2 | grep -q aarch64; then
  curl -sSL -o /tmp/sdkt.zip https://github.com/lzhiyong/android-sdk-tools/releases/download/35.0.2/android-sdk-tools-static-aarch64.zip
  rm -rf /tmp/sdkt && mkdir /tmp/sdkt && unzip -q /tmp/sdkt.zip -d /tmp/sdkt
  for v in 35.0.0 36.0.0; do for b in aapt2 aapt zipalign aidl dexdump split-select; do cp /tmp/sdkt/build-tools/$b $ANDROID_HOME/build-tools/$v/$b; done; done
fi
# 6. Gradle settings: go through the local proxy, trust the sandbox CA, ARM aapt2
export GRADLE_USER_HOME=$T/gradle-home; mkdir -p $GRADLE_USER_HOME
cat > $GRADLE_USER_HOME/gradle.properties <<G
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=8899
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=8899
systemProp.javax.net.ssl.trustStore=$TS
systemProp.javax.net.ssl.trustStorePassword=changeit
org.gradle.jvmargs=-Xmx3g -Djavax.net.ssl.trustStore=$TS -Djavax.net.ssl.trustStorePassword=changeit
G
[ "$ARCH" = aarch64 ] && echo "android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/36.0.0/aapt2" >> $GRADLE_USER_HOME/gradle.properties
# 7. web build + sync + detached gradle
cd "$PROJ"
[ -d node_modules ] || npm ci
npm run build >/dev/null && npx cap sync android >/dev/null
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
rm -f /tmp/gradle-build.log
(cd android && setsid nohup bash -c "./gradlew assembleDebug --console=plain > /tmp/gradle-build.log 2>&1; echo EXIT \$? >> /tmp/gradle-build.log" </dev/null >/dev/null 2>&1 &)
echo "Gradle started; tail /tmp/gradle-build.log, then: bash scripts/sandbox/build-apk.sh --copy"
