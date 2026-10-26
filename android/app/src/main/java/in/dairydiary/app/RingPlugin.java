package in.dairydiary.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
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

    @PluginMethod
    public void sync(PluginCall call) {
        Context ctx = getContext();
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
            setAll(ctx);
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
        prefs(ctx).edit().clear().apply();
        call.resolve();
    }

    /** (Re)sets the alarms of every stored ring still in the future. Also used after a reboot. */
    static void setAll(Context ctx) {
        try {
            JSONArray rings = new JSONArray(prefs(ctx).getString("rings", "[]"));
            long now = System.currentTimeMillis();
            for (int i = 0; i < rings.length(); i++) {
                JSONObject r = rings.getJSONObject(i);
                long at = r.optLong("at");
                if (at > now) setAlarm(ctx, r.optInt("id"), at);
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
