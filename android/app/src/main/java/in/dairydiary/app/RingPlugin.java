package in.dairydiary.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Register ring (v1.10.55). Replaces the plain local notifications of 1.10.12.
 *
 * JS sends the planned rings plus the days this phone already knows are filled (sync). Each ring
 * is an exact AlarmManager alarm. When it fires, RingReceiver checks AGAIN before ringing:
 *   1. the day is in this phone's filled list -> no ring;
 *   2. otherwise it asks Firestore (REST, with this phone's own sign-in) whether ANY phone has
 *      filled that day -> filled = no ring. This is what stops the ring on a phone whose app was
 *      closed while another phone (the brother's) filled the register.
 *   3. not filled, or no internet -> ring on the ALARM stream (loud), with a Close button.
 */
@CapacitorPlugin(name = "DdRing")
public class RingPlugin extends Plugin {
    static final String PREFS = "dd_ring";
    static final String ACTION_RING = "in.dairydiary.app.RING";

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Battery: is the app exempt from battery optimisation (Doze)? */
    @PluginMethod
    public void batteryStatus(PluginCall call) {
        JSObject r = new JSObject();
        boolean ok = true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                ok = pm == null || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            }
        } catch (Exception e) {
            ok = true;
        }
        r.put("ignoring", ok);
        call.resolve(r);
    }

    /** Opens the system "allow / don't optimise battery" dialog for this app. */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject r = new JSObject();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            r.put("opened", true);
        } catch (Exception e) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                r.put("opened", true);
            } catch (Exception e2) {
                r.put("opened", false);
            }
        }
        call.resolve(r);
    }

    @PluginMethod
    public void sync(PluginCall call) {
        Context ctx = getContext();
        // the app is open, so any ring is long over: give the user's alarm volume back now
        RingReceiver.restoreVolume(ctx);
        try {
            JSArray rings = call.getArray("rings", new JSArray());
            JSArray filled = call.getArray("filled", new JSArray());
            JSObject auth = call.getObject("auth", new JSObject());
            SharedPreferences p = prefs(ctx);
            JSONArray old = new JSONArray(p.getString("rings", "[]"));
            // cancel every alarm that was set before, then set the new plan
            for (int i = 0; i < old.length(); i++) cancelAlarm(ctx, old.getJSONObject(i).optInt("id"));
            p.edit()
                .putString("rings", rings.toString())
                .putString("filled", filled.toString())
                .putString("apiKey", auth.optString("apiKey", ""))
                .putString("projectId", auth.optString("projectId", ""))
                .putString("farmId", auth.optString("farmId", ""))
                .putString("refreshToken", auth.optString("refreshToken", ""))
                .putString("closeTitle", call.getString("closeTitle", "Close"))
                .putString("channelName", call.getString("channelName", "Register ring"))
                .apply();
            setAll(ctx, false);
            call.resolve();
        } catch (Exception e) {
            call.reject("ring sync failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        Context ctx = getContext();
        try {
            JSONArray old = new JSONArray(prefs(ctx).getString("rings", "[]"));
            for (int i = 0; i < old.length(); i++) cancelAlarm(ctx, old.getJSONObject(i).optInt("id"));
        } catch (Exception ignored) {
        }
        // clear() below deletes "volBefore": put the user's volume back first, and drop the
        // pending RESTORE alarm (it would find nothing to restore)
        RingReceiver.restoreVolume(ctx);
        RingReceiver.cancelRestore(ctx);
        prefs(ctx).edit().clear().apply();
        call.resolve();
    }

    static final long LATE_MS = 2 * 3600 * 1000L; // a ring more than 2 h late is dropped

    /**
     * (Re)sets the alarms of every stored ring still in the future. Also used after a reboot.
     * afterBoot: a ring whose time passed while the phone was switched off (less than 2 h ago, and
     * never handled - no "done_" mark) rings shortly after boot. Not after an app update
     * (MY_PACKAGE_REPLACED) or a sync, so nothing rings twice.
     */
    static void setAll(Context ctx, boolean afterBoot) {
        try {
            SharedPreferences p = prefs(ctx);
            JSONArray rings = new JSONArray(p.getString("rings", "[]"));
            long now = System.currentTimeMillis();
            int missed = 0;
            for (int i = 0; i < rings.length(); i++) {
                JSONObject r = rings.getJSONObject(i);
                long at = r.optLong("at");
                int id = r.optInt("id");
                if (at > now) {
                    setAlarm(ctx, id, at);
                } else if (afterBoot && at > 0 && now - at < LATE_MS && p.getLong("done_" + id, 0L) != at) {
                    setAlarm(ctx, id, now + 15000L + missed * 20000L); // missed while switched off: ring now
                    missed++;
                }
            }
        } catch (Exception ignored) {
        }
    }

    static PendingIntent ringIntent(Context ctx, int id, int flags) {
        Intent i = new Intent(ctx, RingReceiver.class).setAction(ACTION_RING).putExtra("id", id);
        return PendingIntent.getBroadcast(ctx, id, i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    static void setAlarm(Context ctx, int id, long at) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = ringIntent(ctx, id, PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (exact && Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else if (exact) {
                am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
            } else if (Build.VERSION.SDK_INT >= 23) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    static void cancelAlarm(Context ctx, int id) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = ringIntent(ctx, id, PendingIntent.FLAG_NO_CREATE);
        if (am != null && pi != null) {
            am.cancel(pi);
            pi.cancel();
        }
    }
}
