package in.dairydiary.app;

import android.content.Context;
import android.content.Intent;
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

    @PluginMethod
    public void setPending(PluginCall call) {
        pending = Boolean.TRUE.equals(call.getBoolean("pending", false));
        if (!pending) stop(getContext());
        else if (inBackground) start(getContext());
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        inBackground = true;
        if (pending) start(getContext());
    }

    @Override
    protected void handleOnResume() {
        inBackground = false;
        stop(getContext());
    }

    static void start(Context ctx) {
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, SyncKeepService.class));
        } catch (Exception e) {
            // Android may refuse a start from the background; the data stays queued and uploads on next open.
        }
    }

    static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, SyncKeepService.class));
        } catch (Exception ignored) {
        }
    }
}
