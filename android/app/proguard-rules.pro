# The page's side of the bridge is called by name from JavaScript.
-keepclassmembers class mn.basu.app.shell.ServicePage$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
