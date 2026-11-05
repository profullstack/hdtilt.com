package com.hdtilt.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import org.json.JSONObject;

/**
 * hdtilt (hdtilt.com) on Fire TV: the web app in a full-screen WebView.
 *
 * The web app already drives itself with a remote (arrows, OK, Back, its own
 * focus and big page buttons; the Fire TV user agent switches its TV mode on),
 * so keys go straight to the page. Native code only does what a page cannot:
 * the Fire TV keyboard for text fields, media keys, Back through history,
 * full-screen video and the offline screen.
 */
public class MainActivity extends Activity {

    static final String HOME = "https://hdtilt.com/";
    static final String OFFLINE = "file:///android_asset/offline.html";

    /** "text:{...}" when the focused element is a text field, else "native". */
    static final String FOCUSED_FIELD =
            "(function(){var a=document.activeElement;if(!a)return 'native';"
            + "var t=(a.getAttribute('type')||'text').toLowerCase();"
            + "var text=a.tagName==='TEXTAREA'||(a.tagName==='INPUT'&&/^(text|search|email|password|url|tel|number)$/.test(t));"
            + "if(!text||a.disabled||a.readOnly)return 'native';"
            + "return 'text:'+JSON.stringify({value:a.value||'',hint:a.placeholder||a.getAttribute('aria-label')||'',type:t});})()";

    private WebView web;
    private FrameLayout root;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private AlertDialog keyboard;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0F14);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0F14);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " hdtilt-tv");
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(HOME);
        web.requestFocus();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (keyboard != null) keyboard.dismiss();
        web.destroy();
        super.onDestroy();
    }

    // ---- keys -------------------------------------------------------------

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (fullscreen != null || keyboard != null && keyboard.isShowing()) return super.dispatchKeyEvent(e);
        int code = e.getKeyCode();
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) enter(e);
            return true;
        }
        String media = null;
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: media = "v.paused?v.play():v.pause()"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY: media = "v.play()"; break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: media = "v.pause()"; break;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: media = "isFinite(v.duration)&&(v.currentTime+=30)"; break;
            case KeyEvent.KEYCODE_MEDIA_REWIND: media = "isFinite(v.duration)&&(v.currentTime-=15)"; break;
            default: break;
        }
        if (media != null) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                web.evaluateJavascript("(function(){var v=document.querySelector('video');if(v){" + media + "}})()", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public void onBackPressed() {
        if (fullscreen != null) {
            exitFullscreen();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /** OK on a text field opens the Fire TV keyboard; anywhere else the page gets Enter. */
    private void enter(final KeyEvent original) {
        web.evaluateJavascript(FOCUSED_FIELD, new android.webkit.ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                String r = unquote(v);
                if (r != null && r.startsWith("text:")) {
                    try {
                        JSONObject f = new JSONObject(r.substring(5));
                        openKeyboard(f.optString("value"), f.optString("hint"), f.optString("type"));
                        return;
                    } catch (Exception ignored) {
                        // fall through to the page
                    }
                }
                web.dispatchKeyEvent(original);
                web.dispatchKeyEvent(KeyEvent.changeAction(original, KeyEvent.ACTION_UP));
            }
        });
    }

    /**
     * A native text box: the one thing guaranteed to bring up the Fire TV
     * keyboard (and its microphone). The text goes back into the page's field
     * as if typed, so filters and forms see their usual input events.
     */
    private void openKeyboard(String value, String hint, String type) {
        if (keyboard != null && keyboard.isShowing()) return;
        final EditText box = new EditText(this);
        box.setSingleLine(true);
        box.setText(value);
        box.setSelection(box.getText().length());
        box.setHint(hint);
        box.setTextSize(22);
        int input = InputType.TYPE_CLASS_TEXT;
        if ("email".equals(type)) input |= InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS;
        else if ("url".equals(type)) input |= InputType.TYPE_TEXT_VARIATION_URI;
        else if ("password".equals(type)) input |= InputType.TYPE_TEXT_VARIATION_PASSWORD;
        else if ("number".equals(type) || "tel".equals(type)) input = InputType.TYPE_CLASS_NUMBER;
        box.setInputType(input);
        box.setImeOptions(EditorInfo.IME_ACTION_DONE | EditorInfo.IME_FLAG_NO_EXTRACT_UI);

        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, pad / 2, pad, 0);
        wrap.addView(box);

        final Runnable submit = new Runnable() {
            @Override
            public void run() {
                String text = box.getText().toString();
                if (keyboard != null) keyboard.dismiss();
                web.evaluateJavascript("(function(t){var a=document.activeElement;if(!a)return;"
                        + "var p=a.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;"
                        + "Object.getOwnPropertyDescriptor(p,'value').set.call(a,t);"
                        + "a.dispatchEvent(new Event('input',{bubbles:true}));"
                        + "a.dispatchEvent(new Event('change',{bubbles:true}));})(" + JSONObject.quote(text) + ")", null);
                web.requestFocus();
            }
        };

        keyboard = new AlertDialog.Builder(this, R.style.HdDialog)
                .setTitle(R.string.app_name)
                .setView(wrap)
                .setPositiveButton(R.string.done, new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int w) { submit.run(); }
                })
                .create();
        box.setOnEditorActionListener(new android.widget.TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(android.widget.TextView v, int action, KeyEvent ev) {
                submit.run();
                return true;
            }
        });
        keyboard.setOnShowListener(new android.content.DialogInterface.OnShowListener() {
            @Override
            public void onShow(android.content.DialogInterface d) {
                box.requestFocus();
                InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(box, InputMethodManager.SHOW_IMPLICIT);
            }
        });
        if (keyboard.getWindow() != null) {
            keyboard.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        }
        keyboard.show();
    }

    // ---- web clients --------------------------------------------------------

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return route(url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            return route(req.getUrl().toString());
        }

        /** The web stays in the app (sign-in with CoinPay too); mailto:, intent: and the like go to the system. */
        private boolean route(String url) {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(java.util.Locale.ROOT);
            if (scheme.equals("https") || scheme.equals("http")) return false;
            try {
                Intent i = scheme.equals("intent") ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                        : new Intent(Intent.ACTION_VIEW, u);
                i.addCategory(Intent.CATEGORY_BROWSABLE);
                i.setComponent(null);
                i.setSelector(null);
                startActivity(i);
            } catch (Exception ignored) {
                // Nothing on a TV handles it; staying put beats an error page.
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) web.loadUrl(OFFLINE);
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int code, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) web.loadUrl(OFFLINE);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback done) {
            if (fullscreen != null) {
                done.onCustomViewHidden();
                return;
            }
            fullscreen = view;
            fullscreenDone = done;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }
    }

    private void exitFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;
        web.setVisibility(View.VISIBLE);
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
        web.requestFocus();
    }

    /** evaluateJavascript hands back a JSON value; ours are strings. */
    static String unquote(String v) {
        if (v == null || "null".equals(v)) return null;
        try {
            return new JSONObject("{\"v\":" + v + "}").optString("v", null);
        } catch (Exception e) {
            return null;
        }
    }
}
