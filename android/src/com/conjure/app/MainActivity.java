package com.conjure.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.os.Environment;
import android.view.View;
import android.view.Window;
import android.webkit.URLUtil;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Conjure for Android: a full-screen WebView around the Conjure web app.
 * By default it opens http://localhost:4317, which reaches the computer running
 * `npm start` once `adb reverse tcp:4317 tcp:4317` (and 4318 for previews) is set.
 * Launch with `--es url http://host:port` to point it at another server; the
 * choice is remembered.
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://localhost:4317/";
    private WebView web;
    private String home;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#5b3df5"));

        SharedPreferences prefs = getSharedPreferences("conjure", Context.MODE_PRIVATE);
        String fromIntent = getIntent().getStringExtra("url");
        if (fromIntent != null && URLUtil.isNetworkUrl(fromIntent)) {
            prefs.edit().putString("url", fromIntent).apply();
        }
        home = prefs.getString("url", DEFAULT_URL);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0f0f12"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " ConjureAndroid/0.1");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline(String.valueOf(err.getDescription()));
            }
        });

        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            try {
                String name = URLUtil.guessFileName(url, disposition, mime);
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                r.setMimeType(mime);
                r.addRequestHeader("User-Agent", userAgent);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });

        // Android 15 draws apps edge to edge; pad the content so it clears the
        // status bar, navigation bar and on-screen keyboard.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#5b3df5"));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top, bottom, left, right;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top; left = bars.left; right = bars.right; bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft(); right = insets.getSystemWindowInsetRight();
            }
            v.setPadding(left, top, right, bottom);
            return insets;
        });
        setContentView(root);
        if (state != null) web.restoreState(state);
        else web.loadUrl(home);
    }

    private void showOffline(String why) {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{font-family:sans-serif;background:#0f0f12;color:#eee;padding:32px 20px}"
            + "h1{color:#9d8bff;font-size:22px}code{background:#222;padding:2px 6px;border-radius:4px}"
            + "button{margin-top:20px;padding:12px 20px;border:0;border-radius:8px;background:#5b3df5;color:#fff;font-size:16px}</style></head>"
            + "<body><h1>&#10022; Can't reach Conjure</h1><p>" + escape(why) + "</p>"
            + "<p>Start the server on your computer with <code>npm start</code>, then connect this phone with "
            + "<code>adb reverse tcp:4317 tcp:4317</code> and <code>adb reverse tcp:4318 tcp:4318</code>.</p>"
            + "<p>Server: <code>" + escape(home) + "</code></p>"
            + "<button onclick=\"location.href='" + escape(home) + "'\">Retry</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;").replace("\"", "&quot;");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
