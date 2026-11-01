package in.dairydiary.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import androidx.core.app.NotificationCompat;

/** Keeps the process alive while entries wait for the server. See SyncKeeperPlugin. */
public class SyncKeepService extends Service {
    static final String CHANNEL = "dd_sync";
    // 7100-7207 belong to the register rings (reminders.js) - never reuse them here
    static final int NOTE_ID = 9101;
    static final int REMIND_ID = 9102;
    static final long MAX_MS = 5L * 60 * 60 * 1000; // never run longer than 5 h
    private final Handler handler = new Handler(Looper.getMainLooper());
    // main thread only (see SyncKeeperPlugin.start/stop)
    static volatile SyncKeepService live = null; // set once startForeground() succeeded
    static volatile boolean stopWanted = false;

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "डेटा अपलोड / Data upload", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel(this);
    }

    private static PendingIntent openApp(Context ctx) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent openApp() {
        return openApp(this);
    }

    /** "Some entries are not on the server yet, open the app once with internet." */
    static void postReminder(Context ctx) {
        try {
            ensureChannel(ctx);
            Notification r = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Dairy Diary")
                .setContentText("कुछ एंट्री अभी सर्वर पर नहीं गईं, नेट के साथ ऐप एक बार खोलें")
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx))
                .build();
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(REMIND_ID, r);
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Dairy Diary")
            .setContentText("नेट आते ही एंट्री सर्वर पर चली जाएँगी / Entries upload when online")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp())
            .build();
        if (SyncKeeperPlugin.startsInFlight > 0) SyncKeeperPlugin.startsInFlight--;
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) {
            // the system refused the foreground service: do not stopSelf() here (that is the crash path);
            // SyncKeeperPlugin.stop() stops it with stopService() when nothing is pending any more
            return START_NOT_STICKY;
        }
        live = this;
        // Not wanted any more (back in the app, or nothing pending): stop now that it is in the foreground.
        // Another start still on its way stops it after its own startForeground().
        if (stopWanted || !SyncKeeperPlugin.pending || !SyncKeeperPlugin.inBackground) {
            if (SyncKeeperPlugin.startsInFlight == 0) {
                stopWanted = false;
                live = null;
                stopSelf();
            }
            return START_NOT_STICKY;
        }
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::stopSelf, MAX_MS);
        return START_NOT_STICKY;
    }

    /** App swiped away from recents: the screen (and its uploader) is gone - remind the user to open it once. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (SyncKeeperPlugin.pending) postReminder(this);
        live = null;
        stopSelf();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        live = null;
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
