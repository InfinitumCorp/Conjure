package com.conjure.app;

/**
 * Amplitude identifiers for this app.
 *
 * TODO: This app is not built with Gradle, so the Amplitude Android SDK
 * (com.amplitude:analytics-android:1.37.1) cannot be added here without
 * breaking the existing build. When the app is moved to Gradle, add:
 *   implementation("com.amplitude:analytics-android:1.37.1")
 * then initialize in the existing Application or Activity onCreate with
 * privacy defaults: sessions, app lifecycles and screen views only; no
 * element or frustration autocapture; IP, city, DMA, lat-lng and advertising
 * IDs disabled; remote config and diagnostics off. Do not change existing
 * screens or layout.
 *
 * The value below is the public API key, never the Secret key.
 */
public final class AmplitudeConfig {
    private AmplitudeConfig() {}

    public static final String API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";
}
