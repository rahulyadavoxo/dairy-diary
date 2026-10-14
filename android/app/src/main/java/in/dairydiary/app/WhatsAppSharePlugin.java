package in.dairydiary.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "WhatsAppShare")
public class WhatsAppSharePlugin extends Plugin {
    private static final String[] PKGS = { "com.whatsapp", "com.whatsapp.w4b" };

    private String installedPkg() {
        PackageManager pm = getContext().getPackageManager();
        for (String p : PKGS) {
            try { pm.getPackageInfo(p, 0); return p; } catch (PackageManager.NameNotFoundException ignored) { }
        }
        return null;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", installedPkg() != null);
        call.resolve(r);
    }

    @PluginMethod
    public void shareImage(PluginCall call) {
        String b64 = call.getString("base64");
        String fileName = call.getString("fileName", "bill.png");
        String phone = call.getString("phone");
        if (b64 == null || b64.isEmpty()) { call.reject("No image", "NO_IMAGE"); return; }
        String pkg = installedPkg();
        if (pkg == null) { call.reject("WhatsApp not installed", "NOT_INSTALLED"); return; }
        try {
            File dir = new File(getContext().getCacheDir(), "bills");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("mkdir failed");
            String safe = fileName.replaceAll("[^A-Za-z0-9._-]", "_");
            if (!safe.endsWith(".png")) safe = safe + ".png";
            File f = new File(dir, safe);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(Base64.decode(b64, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("image/png");
            i.setPackage(pkg);
            i.putExtra(Intent.EXTRA_STREAM, uri); // photo only, no EXTRA_TEXT
            boolean direct = phone != null && phone.matches("\\d{11,15}");
            if (direct) i.putExtra("jid", phone + "@s.whatsapp.net");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            JSObject r = new JSObject();
            r.put("direct", direct);
            r.put("package", pkg);
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            call.reject("WhatsApp not installed", "NOT_INSTALLED", e);
        } catch (Exception e) {
            call.reject("Share failed: " + e.getMessage(), "SHARE_FAILED", e);
        }
    }
}
