package in.dairydiary.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WhatsAppSharePlugin.class); // must be BEFORE super.onCreate
        registerPlugin(ApkUpdaterPlugin.class);
        registerPlugin(SyncKeeperPlugin.class);
        registerPlugin(RingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
