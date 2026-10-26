package tech.uznik322.reading;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle state) {
        registerPlugin(readingplugin.class);
        super.onCreate(state);
    }
}
