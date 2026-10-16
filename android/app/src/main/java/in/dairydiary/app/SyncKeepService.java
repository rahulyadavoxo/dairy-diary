package in.dairydiary.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
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

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "डेटा अपलोड / Data upload", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
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
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::stopSelf, MAX_MS);
        return START_NOT_STICKY;
    }

    /** App swiped away from recents: the screen (and its uploader) is gone - remind the user to open it once. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (SyncKeeperPlugin.pending) {
            Notification r = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Dairy Diary")
                .setContentText("कुछ एंट्री अभी सर्वर पर नहीं गईं, नेट के साथ ऐप एक बार खोलें")
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .build();
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            try {
                if (nm != null) nm.notify(REMIND_ID, r);
            } catch (Exception ignored) {
            }
        }
        stopSelf();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
