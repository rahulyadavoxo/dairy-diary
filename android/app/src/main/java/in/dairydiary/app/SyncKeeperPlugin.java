package in.dairydiary.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Background upload (v1.10.49). JS reports whether any Firestore write is still waiting for the
 * server (setPending). While something is pending and the app goes to the background, a small
 * foreground service keeps the app process alive, so the Firebase SDK can finish the upload by
 * itself as soon as the internet comes back. When nothing is pending, no service runs.
 */
@CapacitorPlugin(name = "SyncKeeper")
public class SyncKeeperPlugin extends Plugin {
    static volatile boolean pending = false;
    static volatile boolean inBackground = false;

    private static final android.os.Handler MAIN = new android.os.Handler(android.os.Looper.getMainLooper());

    @PluginMethod
    public void setPending(PluginCall call) {
        final boolean p = Boolean.TRUE.equals(call.getBoolean("pending", false));
        final Context ctx = getContext().getApplicationContext();
        // pause/resume run on the main thread: serialise every start/stop there too
        MAIN.post(() -> {
            pending = p;
            if (!p) stop(ctx);
            else if (inBackground) start(ctx);
        });
        call.resolve();
    }

    /** Opens this app's notification settings (register ring needs notifications on). */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context ctx = getContext();
        Intent i;
        if (Build.VERSION.SDK_INT >= 26) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("cannot open settings");
        }
    }

    @Override
    protected void handleOnPause() {
        inBackground = true;
        if (pending) start(getContext().getApplicationContext());
    }

    @Override
    protected void handleOnResume() {
        inBackground = false;
        stop(getContext().getApplicationContext());
    }

    /** The screen (WebView with the uploader) is gone while the process lives on. */
    @Override
    protected void handleOnDestroy() {
        Context ctx = getContext().getApplicationContext();
        // nothing can upload any more: remind the user to open the app once (like onTaskRemoved)
        if (pending) SyncKeepService.postReminder(ctx);
        stop(ctx);
    }

    // start/stop: main thread only. A startForegroundService() must reach startForeground() before
    // the service is stopped, or Android crashes the app ("did not then call startForeground").
    static int startsInFlight = 0;

    static void start(Context ctx) {
        SyncKeepService.stopWanted = false;
        if (SyncKeepService.live != null) return; // already in the foreground
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, SyncKeepService.class));
            startsInFlight++;
        } catch (Exception e) {
            // Android may refuse a start from the background; the data stays queued and uploads on next open.
        }
    }

    static void stop(Context ctx) {
        if (startsInFlight > 0) {
            SyncKeepService.stopWanted = true; // it stops itself right after startForeground()
            return;
        }
        SyncKeepService.live = null;
        try {
            ctx.stopService(new Intent(ctx, SyncKeepService.class));
        } catch (Exception ignored) {
        }
    }
}
