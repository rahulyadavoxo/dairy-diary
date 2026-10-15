package in.dairydiary.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * In-app update: downloads the new APK from the GitHub release and opens Android's installer.
 * download({url}) -> {size}; install() -> {started:true} or {needsPermission:true}.
 * The downloaded file must be this same app (package name) with a higher versionCode,
 * otherwise it is deleted and rejected. Android itself refuses an APK signed with another key.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {
    private static final String FILE_NAME = "dd-update.apk";
    static final int CONNECT_TIMEOUT_MS = 4000;
    static final int CONNECT_TRIES = 4;
    private volatile boolean busy = false;

    private File apkFile() {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, FILE_NAME);
    }

    @SuppressWarnings("deprecation")
    private long installedVersionCode() throws PackageManager.NameNotFoundException {
        PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
    }

    /** Signing certificates of a PackageInfo (API 28+), or null when they can't be read. */
    private static Set<String> certs(PackageInfo pi) {
        try {
            if (pi == null || Build.VERSION.SDK_INT < 28) return null;
            SigningInfo si = pi.signingInfo;
            if (si == null) return null;
            Signature[] sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
            if (sigs == null || sigs.length == 0) return null;
            Set<String> out = new HashSet<>();
            for (Signature g : sigs) out.add(Arrays.toString(g.toByteArray()));
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    /** Only GitHub hosts may serve the update (also after redirects); no path tricks. */
    static boolean allowedUrl(String u, boolean first) {
        try {
            URL url = new URL(u);
            if (!"https".equals(url.getProtocol())) return false;
            String host = url.getHost().toLowerCase(Locale.ROOT);
            String path = url.getPath();
            if (path.contains("..") || path.contains("%2e") || path.contains("%2E")) return false;
            if (first) return host.equals("github.com") && path.startsWith("/rahulyadavoxo/dairy-diary/releases/download/");
            return host.equals("github.com") || host.endsWith(".githubusercontent.com");
        } catch (Exception e) {
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private String checkApk(File f) {
        try {
            PackageManager pm = getContext().getPackageManager();
            int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : 0;
            PackageInfo pi = pm.getPackageArchiveInfo(f.getAbsolutePath(), flags);
            if (pi == null) return "NOT_APK";
            if (!getContext().getPackageName().equals(pi.packageName)) return "WRONG_APP";
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            if (code <= installedVersionCode()) return "NOT_NEWER";
            // Same signing key as the installed app (Android's installer checks this too; we reject
            // early). If either side can't be read we leave it to the installer.
            Set<String> mine = certs(pm.getPackageInfo(getContext().getPackageName(), flags));
            Set<String> theirs = certs(pi);
            if (mine != null && theirs != null && java.util.Collections.disjoint(mine, theirs)) return "WRONG_SIGNER";
            return null;
        } catch (Exception e) {
            return "NOT_APK";
        }
    }

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !allowedUrl(url, true)) {
            call.reject("Bad update url", "BAD_URL");
            return;
        }
        if (busy) {
            call.reject("Already downloading", "BUSY");
            return;
        }
        busy = true;
        new Thread(() -> {
            File out = apkFile();
            File part = new File(out.getParentFile(), FILE_NAME + ".part");
            HttpURLConnection con = null;
            try {
                String next = url;
                int hops = 0;
                int tries = 0;
                while (true) {
                    con = (HttpURLConnection) new URL(next).openConnection();
                    con.setInstanceFollowRedirects(false);
                    // Short connect timeout: a host can resolve to an address the phone's network can't
                    // reach (often IPv6). Android then waits this long before trying the next address,
                    // so 20 s here meant ~20 s stuck at 0%. 4 s per address, plus retries below.
                    con.setConnectTimeout(CONNECT_TIMEOUT_MS);
                    con.setReadTimeout(30000);
                    con.setRequestProperty("User-Agent", "DairyDiary-Updater");
                    int st;
                    try {
                        st = con.getResponseCode();
                    } catch (java.io.IOException ce) {
                        con.disconnect();
                        if (++tries >= CONNECT_TRIES) throw ce;
                        continue; // same URL again (a fresh connection may pick a working address)
                    }
                    if (st >= 300 && st < 400) {
                        String loc = con.getHeaderField("Location");
                        con.disconnect();
                        if (loc == null || ++hops > 5) throw new Exception("redirect");
                        next = new URL(new URL(next), loc).toString();
                        if (!allowedUrl(next, false)) throw new Exception("redirect host");
                        continue;
                    }
                    if (st != 200) throw new Exception("HTTP " + st);
                    break;
                }
                long total = con.getContentLengthLong();
                long done = 0;
                int lastPct = -1;
                try (InputStream in = con.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        os.write(buf, 0, n);
                        done += n;
                        if (total > 0) {
                            int pct = (int) (done * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                JSObject p = new JSObject();
                                p.put("percent", pct);
                                notifyListeners("progress", p);
                            }
                        }
                    }
                }
                if (total > 0 && done != total) throw new Exception("incomplete");
                if (out.exists()) out.delete();
                if (!part.renameTo(out)) throw new Exception("rename failed");
                String bad = checkApk(out);
                if (bad != null) {
                    out.delete();
                    call.reject("Downloaded file rejected: " + bad, bad);
                    return;
                }
                JSObject r = new JSObject();
                r.put("size", out.length());
                call.resolve(r);
            } catch (Exception e) {
                part.delete();
                call.reject("Download failed: " + e.getMessage(), "DOWNLOAD_FAILED", e);
            } finally {
                if (con != null) con.disconnect();
                busy = false;
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        File f = apkFile();
        if (!f.exists()) {
            call.reject("No downloaded update", "NO_FILE");
            return;
        }
        String bad = checkApk(f);
        if (bad != null) {
            f.delete();
            call.reject("Downloaded file rejected: " + bad, bad);
            return;
        }
        JSObject r = new JSObject();
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(s);
                r.put("needsPermission", true);
                call.resolve(r);
                return;
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            r.put("started", true);
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            call.reject("No installer", "NO_INSTALLER", e);
        } catch (Exception e) {
            call.reject("Install failed: " + e.getMessage(), "INSTALL_FAILED", e);
        }
    }
}
