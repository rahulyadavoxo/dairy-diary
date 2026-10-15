package in.dairydiary.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
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

/**
 * In-app update: downloads the new APK from the GitHub release and opens Android's installer.
 * download({url}) -> {size}; install() -> {started:true} or {needsPermission:true}.
 * The downloaded file must be this same app (package name) with a higher versionCode,
 * otherwise it is deleted and rejected. Android itself refuses an APK signed with another key.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {
    private static final String FILE_NAME = "dd-update.apk";
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

    @SuppressWarnings("deprecation")
    private String checkApk(File f) {
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            if (pi == null) return "NOT_APK";
            if (!getContext().getPackageName().equals(pi.packageName)) return "WRONG_APP";
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            if (code <= installedVersionCode()) return "NOT_NEWER";
            return null;
        } catch (Exception e) {
            return "NOT_APK";
        }
    }

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.startsWith("https://github.com/rahulyadavoxo/dairy-diary/releases/download/")) {
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
                while (true) {
                    con = (HttpURLConnection) new URL(next).openConnection();
                    con.setInstanceFollowRedirects(false);
                    con.setConnectTimeout(20000);
                    con.setReadTimeout(30000);
                    con.setRequestProperty("User-Agent", "DairyDiary-Updater");
                    int st = con.getResponseCode();
                    if (st >= 300 && st < 400) {
                        String loc = con.getHeaderField("Location");
                        con.disconnect();
                        if (loc == null || !loc.startsWith("https://") || ++hops > 5) throw new Exception("redirect");
                        next = loc;
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
