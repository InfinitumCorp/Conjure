package com.conjure.app;

import android.app.Application;
import com.amplitude.android.Amplitude;
import com.amplitude.android.AutocaptureOption;
import com.amplitude.android.Configuration;
import com.amplitude.android.TrackingOptions;
import com.amplitude.core.ServerZone;
import java.util.EnumSet;

/**
 * Starts Amplitude analytics (official SDK, vendored by scripts/fetch-deps.sh).
 * Public API key only; never identifies a user. Tracks sessions, app opens and screen
 * views and nothing else: no element or frustration interactions, no deep links, no
 * remote config, no diagnostics, no IP, city, DMA, lat/lng or advertising/app-set IDs.
 */
public class ConjureApp extends Application {
    private static final String AMPLITUDE_PUBLIC_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            Configuration c = new Configuration(AMPLITUDE_PUBLIC_KEY, this);
            c.setServerZone(ServerZone.US);
            c.setAutocapture(EnumSet.of(AutocaptureOption.SESSIONS, AutocaptureOption.APP_LIFECYCLES, AutocaptureOption.SCREEN_VIEWS));
            c.setEnableAutocaptureRemoteConfig(false);
            c.setEnableDiagnostics(false);
            c.setTrackingOptions(new TrackingOptions()
                .disableIpAddress().disableCity().disableDma().disableLatLng().disableAdid().disableAppSetId());
            c.setUseAdvertisingIdForDeviceId(false);
            c.setUseAppSetIdForDeviceId(false);
            c.setLocationListening(false);
            new Amplitude(c);
        } catch (Throwable t) {
            // Analytics must never stop the app from opening.
        }
    }
}
