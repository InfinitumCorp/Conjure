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
import android.webkit.CookieManager;
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
    private static final String VERSION = "0.3.0";
    private WebView web;
    private String home;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        Window w = getWindow();
        w.setStatusBarColor(Color.WHITE);
        w.setNavigationBarColor(Color.WHITE);
        // Dark status and navigation bar icons on the white house background.
        if (Build.VERSION.SDK_INT >= 30) {
            w.getDecorView().post(() -> {
                android.view.WindowInsetsController c = w.getInsetsController();
                if (c != null) c.setSystemBarsAppearance(
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            });
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        SharedPreferences prefs = getSharedPreferences("conjure", Context.MODE_PRIVATE);
        String fromIntent = getIntent().getStringExtra("url");
        if (fromIntent != null && URLUtil.isNetworkUrl(fromIntent)) {
            prefs.edit().putString("url", fromIntent).apply();
        }
        home = prefs.getString("url", getString(R.string.server_url));

        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " ConjureAndroid/" + VERSION);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline(String.valueOf(err.getDescription()));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("conjure".equals(u.getScheme()) && "server".equals(u.getHost())) {
                    // From the offline page's "Use this server" form.
                    String next = u.getQueryParameter("url");
                    if (next != null && !next.endsWith("/")) next = next + "/";
                    if (next != null && URLUtil.isNetworkUrl(next)) {
                        home = next;
                        getSharedPreferences("conjure", Context.MODE_PRIVATE).edit().putString("url", next).apply();
                        view.loadUrl(next);
                    } else {
                        Toast.makeText(MainActivity.this, "Enter an http:// or https:// address", Toast.LENGTH_SHORT).show();
                    }
                    return true;
                }
                return false;
            }
        });

        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            try {
                String name = URLUtil.guessFileName(url, disposition, mime);
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                r.setMimeType(mime);
                r.addRequestHeader("User-Agent", userAgent);
                // Downloads need the signed-in session (cloud servers require sign-in).
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null) r.addRequestHeader("Cookie", cookie);
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
        root.setBackgroundColor(Color.WHITE);
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
        String field = "width:100%;box-sizing:border-box;padding:16px;border:1px solid #111820;border-radius:0;background:#fff;color:#111820;font:inherit;font-size:17px";
        String html = "<!doctype html><html lang='en'><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<style>body{margin:0;padding:40px 20px;background:#fff;color:#111820;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55}"
            + "h1{font-weight:400;font-size:48px;line-height:1;letter-spacing:-.065em;margin:0 0 20px}"
            + "sup{font-size:.38em;vertical-align:super;line-height:0;margin-left:.08em;letter-spacing:0}"
            + "p{color:#52606b}code{color:#111820}hr{border:0;border-top:1px solid #d6dce1;margin:28px 0}"
            + "button{margin-top:14px;padding:17px 22px;border:1px solid #111820;border-radius:0;background:#111820;color:#fff;font:inherit}"
            + "button.sec{background:#fff;color:#111820;padding:13px 20px}</style></head>"
            + "<body><h1>Can't reach Conjure<sup>&trade;</sup></h1><p>" + escape(why) + "</p>"
            + "<p>Check your connection and that the server is running. For a server on your computer, run <code>npm start</code> and connect this phone with "
            + "<code>adb reverse tcp:4317 tcp:4317</code> and <code>adb reverse tcp:4318 tcp:4318</code>.</p>"
            + "<button onclick=\"location.href='" + escape(home) + "'\">Retry</button>"
            + "<hr><form action='conjure://server' method='get'>"
            + "<p>Or use another server:</p>"
            + "<input name='url' type='url' aria-label='Server address' value='" + escape(home) + "' style='" + field + "'>"
            + "<button class='sec'>Use this server</button></form></body></html>";
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
