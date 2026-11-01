package in.dairydiary.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fires a planned register ring only if the day is still empty on every phone (see RingPlugin). */
public class RingReceiver extends BroadcastReceiver {
    static final String CHANNEL = "dd_ring_v2"; // v2 = ALARM stream (v1 used the quiet notification stream)
    static final String ACTION_CLOSE = "in.dairydiary.app.RING_CLOSE";
    static final String ACTION_RESTORE = "in.dairydiary.app.RING_RESTORE";
    static final int RESTORE_ID = 7399;
    static final long RING_MS = 15000; // dd_ring.ogg is 15 s

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (a == null) return;
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            restoreVolume(ctx);
            RingPlugin.setAll(ctx, Intent.ACTION_BOOT_COMPLETED.equals(a));
            return;
        }
        if (ACTION_CLOSE.equals(a)) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(intent.getIntExtra("id", 0));
            restoreVolume(ctx);
            return;
        }
        if (ACTION_RESTORE.equals(a)) {
            restoreVolume(ctx);
            return;
        }
        if (!RingPlugin.ACTION_RING.equals(a)) return;
        final int id = intent.getIntExtra("id", 0);
        final PendingResult done = goAsync();
        new Thread(() -> {
            try {
                handleRing(ctx, id);
            } catch (Exception ignored) {
            } finally {
                done.finish();
            }
        }).start();
    }

    private static void handleRing(Context ctx, int id) throws Exception {
        SharedPreferences p = RingPlugin.prefs(ctx);
        JSONArray rings = new JSONArray(p.getString("rings", "[]"));
        JSONObject ring = null;
        for (int i = 0; i < rings.length(); i++) {
            if (rings.getJSONObject(i).optInt("id") == id) ring = rings.getJSONObject(i);
        }
        if (ring == null) return; // no longer planned
        // handled: a reboot must not fire this ring again (RingPlugin.setAll afterBoot)
        p.edit().putLong("done_" + id, ring.optLong("at")).apply();
        // a late alarm (phone was off) for a ring more than 2 hours old is dropped
        if (System.currentTimeMillis() - ring.optLong("at") > RingPlugin.LATE_MS) return;
        String day = ring.optString("day");
        JSONArray filled = new JSONArray(p.getString("filled", "[]"));
        for (int i = 0; i < filled.length(); i++) if (day.equals(filled.optString(i))) return;
        int server = checkServer(p, day);
        if (server == FILLED) {
            filled.put(day);
            p.edit().putString("filled", filled.toString()).apply();
            return;
        }
        if (server == NO_ACCESS) {
            // signed out / removed from the farm: this phone must stop ringing (the app may never be
            // opened again to cancel). The next sign-in syncs a fresh plan.
            JSONArray all = new JSONArray(p.getString("rings", "[]"));
            for (int i = 0; i < all.length(); i++) RingPlugin.cancelAlarm(ctx, all.getJSONObject(i).optInt("id"));
            p.edit().putString("rings", "[]").apply();
            return;
        }
        show(ctx, p, id, ring);
    }

    static final int FILLED = 1, EMPTY = 0, UNKNOWN = -1, NO_ACCESS = -2;

    /**
     * Asks Firestore, with one retry and everything under one 20 s deadline (DNS included): after an
     * idle alarm the network often needs a few seconds to wake up. goAsync allows far more than 20 s.
     */
    static int checkServer(final SharedPreferences p, final String day) {
        ExecutorService ex = Executors.newSingleThreadExecutor();
        try {
            long end = System.currentTimeMillis() + 20000L;
            for (int attempt = 0; attempt < 2; attempt++) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) return UNKNOWN;
                Future<Integer> f = ex.submit(new Callable<Integer>() {
                    @Override
                    public Integer call() {
                        return filledOnServer(p, day);
                    }
                });
                try {
                    Integer r = f.get(Math.min(left, 9000L), TimeUnit.MILLISECONDS);
                    if (r != null && r != UNKNOWN) return r;
                } catch (InterruptedException e) {
                    f.cancel(true);
                    return UNKNOWN;
                } catch (Exception e) {
                    f.cancel(true); // timed out or failed
                }
                if (attempt == 0) {
                    long wait = Math.min(3000L, end - System.currentTimeMillis());
                    if (wait > 0) Thread.sleep(wait); // let the network come up
                }
            }
            return UNKNOWN;
        } catch (InterruptedException e) {
            return UNKNOWN;
        } finally {
            ex.shutdownNow();
        }
    }

    /**
     * FILLED / EMPTY from Firestore; UNKNOWN when it could not be checked (no internet, server error);
     * NO_ACCESS when this phone's sign-in is dead (token revoked / user gone) or the farm refuses it.
     */
    static int filledOnServer(SharedPreferences p, String day) {
        String key = p.getString("apiKey", ""), project = p.getString("projectId", "");
        String farm = p.getString("farmId", ""), refresh = p.getString("refreshToken", "");
        if (key.isEmpty() || project.isEmpty() || farm.isEmpty() || refresh.isEmpty() || day.isEmpty()) return UNKNOWN;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("https://securetoken.googleapis.com/v1/token?key=" + URLEncoder.encode(key, "UTF-8")).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(4000);
            c.setDoOutput(true);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            try (OutputStream o = c.getOutputStream()) {
                o.write(("grant_type=refresh_token&refresh_token=" + URLEncoder.encode(refresh, "UTF-8")).getBytes("UTF-8"));
            }
            int tc = c.getResponseCode();
            if (tc != 200) {
                String err = "";
                try {
                    InputStream es = c.getErrorStream();
                    if (es != null) err = read(es);
                } catch (Exception ignored) {
                }
                // only these token messages mean "signed out"; a plain 400 can also be a bad/blocked API key
                if (tc == 400 && err.matches("(?s).*(TOKEN_EXPIRED|USER_NOT_FOUND|INVALID_REFRESH_TOKEN|USER_DISABLED).*")) return NO_ACCESS;
                return UNKNOWN;
            }
            String idToken = new JSONObject(read(c.getInputStream())).optString("id_token", "");
            if (idToken.isEmpty()) return UNKNOWN;
            String url = "https://firestore.googleapis.com/v1/projects/" + project + "/databases/(default)/documents/farms/"
                + URLEncoder.encode(farm, "UTF-8") + "/days/" + day + "?mask.fieldPaths=entries";
            HttpURLConnection g = (HttpURLConnection) new URL(url).openConnection();
            g.setConnectTimeout(4000);
            g.setReadTimeout(4000);
            g.setRequestProperty("Authorization", "Bearer " + idToken);
            int code = g.getResponseCode();
            if (code == 404) return EMPTY;
            if (code == 403) return NO_ACCESS; // rules: this phone is no longer in the farm
            if (code != 200) return UNKNOWN;
            JSONObject doc = new JSONObject(read(g.getInputStream()));
            JSONObject f = doc.optJSONObject("fields");
            JSONObject entries = f == null ? null : f.optJSONObject("entries");
            JSONObject map = entries == null ? null : entries.optJSONObject("mapValue");
            JSONObject inner = map == null ? null : map.optJSONObject("fields");
            return (inner != null && inner.length() > 0) ? FILLED : EMPTY;
        } catch (Exception e) {
            return UNKNOWN;
        }
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close();
        return b.toString("UTF-8");
    }

    static void ensureChannel(Context ctx, String name) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        try {
            nm.deleteNotificationChannel("dd_ring_v1");
        } catch (Exception ignored) {
        }
        NotificationChannel ch = new NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(name);
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] {0, 800, 400, 800, 400, 800});
        ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        AudioAttributes aa = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        ch.setSound(soundUri(ctx), aa);
        nm.createNotificationChannel(ch);
    }

    static Uri soundUri(Context ctx) {
        return Uri.parse("android.resource://" + ctx.getPackageName() + "/" + R.raw.dd_ring);
    }

    private static void show(Context ctx, SharedPreferences p, int id, JSONObject ring) {
        ensureChannel(ctx, p.getString("channelName", "Register ring"));
        raiseVolume(ctx);
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent close = new Intent(ctx, RingReceiver.class).setAction(ACTION_CLOSE).putExtra("id", id);
        PendingIntent closePi = PendingIntent.getBroadcast(ctx, id + 1000, close, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_dd)
            .setColor(0xFF1F6F43)
            .setContentTitle(ring.optString("title"))
            .setContentText(ring.optString("body"))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(ring.optString("body")))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(soundUri(ctx), AudioManager.STREAM_ALARM)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .addAction(0, p.getString("closeTitle", "Close"), closePi);
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(id, b.build());
        } catch (SecurityException ignored) {
            // notifications are off; Settings shows the warning
        }
    }

    /** The ring plays on the ALARM stream at full volume, and the user's volume comes back after it. */
    static void raiseVolume(Context ctx) {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            int cur = am.getStreamVolume(AudioManager.STREAM_ALARM);
            int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
            if (cur >= max) return;
            SharedPreferences p = RingPlugin.prefs(ctx);
            if (p.getInt("volBefore", -1) < 0) p.edit().putInt("volBefore", cur).apply();
            am.setStreamVolume(AudioManager.STREAM_ALARM, max, 0);
            AlarmManager al = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            Intent r = new Intent(ctx, RingReceiver.class).setAction(ACTION_RESTORE);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, RESTORE_ID, r, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            long at = System.currentTimeMillis() + RING_MS + 2000;
            if (al != null) {
                // exact: an inexact restore could leave the alarm volume at full for a long time in Doze
                boolean exact = Build.VERSION.SDK_INT < 31 || al.canScheduleExactAlarms();
                try {
                    if (exact && Build.VERSION.SDK_INT >= 23) al.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    else if (Build.VERSION.SDK_INT >= 23) al.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    else al.setExact(AlarmManager.RTC_WAKEUP, at, pi);
                } catch (SecurityException e) {
                    if (Build.VERSION.SDK_INT >= 23) al.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    else al.set(AlarmManager.RTC_WAKEUP, at, pi);
                }
            }
        } catch (Exception ignored) {
            // Do Not Disturb can refuse volume changes; the ring still plays at the user's alarm volume
        }
    }

    /** Drops a pending RESTORE alarm (sign-out: the volume was already restored). */
    static void cancelRestore(Context ctx) {
        try {
            Intent r = new Intent(ctx, RingReceiver.class).setAction(ACTION_RESTORE);
            PendingIntent rp = PendingIntent.getBroadcast(ctx, RESTORE_ID, r, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (rp != null && am != null) {
                am.cancel(rp);
                rp.cancel();
            }
        } catch (Exception ignored) {
        }
    }

    static void restoreVolume(Context ctx) {
        SharedPreferences p = RingPlugin.prefs(ctx);
        int before = p.getInt("volBefore", -1);
        if (before < 0) return;
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) am.setStreamVolume(AudioManager.STREAM_ALARM, before, 0);
        } catch (Exception ignored) {
        }
        p.edit().remove("volBefore").apply();
    }
}
