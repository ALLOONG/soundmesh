package io.github.alloong.soundmesh

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * SoundMesh Android 主机：里面运行的就是网页版的 SoundMesh（网页更新，App 跟着更新），
 * 再补上网页做不到的：抓手机上其他 App 的声音、在后台/锁屏时继续工作。
 */
class MainActivity : Activity() {
    companion object {
        private const val URL = "https://alloong.github.io/soundmesh/?app=android"
        private const val REQ_PROJECTION = 1
        private const val REQ_FILE = 2
        private const val REQ_PERM_CAPTURE = 3
        private const val REQ_PERM_WEB = 4
        @Volatile private var instance: MainActivity? = null

        /** 把抓声音的状态告诉网页：on / off / denied / error */
        fun notifyCapture(state: String, msg: String) {
            val a = instance ?: return
            a.runOnUiThread {
                a.web.evaluateJavascript(
                    "window.__smAppCapture && window.__smAppCapture(${JSONObject.quote(state)}, ${JSONObject.quote(msg)})", null)
            }
        }
    }

    lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        WebView.setWebContentsDebuggingEnabled(true) // 电脑 Chrome 打开 chrome://inspect 可以看到页面，方便排查
        web = WebView(this)
        setContentView(web)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString SoundMeshApp/${BuildConfigCompat.versionName(this@MainActivity)}"
        }
        // 切到后台也保持页面全速运行（不被系统降级）
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        web.addJavascriptInterface(Bridge(), "SoundMeshApp")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.host == "alloong.github.io") return false
                // 其他链接（比如 GitHub）用手机浏览器打开
                return try { startActivity(Intent(Intent.ACTION_VIEW, u)); true } catch (_: Throwable) { true }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsMic = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
                    if (wantsMic && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        pendingWebPermission = request
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_PERM_WEB)
                    } else request.grant(request.resources)
                }
            }

            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                val i = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "audio/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                return try { startActivityForResult(Intent.createChooser(i, "选择音乐"), REQ_FILE); true }
                catch (_: Throwable) { fileCallback = null; false }
            }
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(URL)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 99)
        }
    }

    /** 网页里按「开始抓手机声音」时调用 */
    private fun beginCapture() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_PERM_CAPTURE)
            return
        }
        val mpm = getSystemService(MediaProjectionManager::class.java)
        // Android 14+：直接选“整个屏幕”，这样能抓到所有 App 的声音
        val intent = if (Build.VERSION.SDK_INT >= 34) mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                     else mpm.createScreenCaptureIntent()
        startActivityForResult(intent, REQ_PROJECTION)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        val ok = results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED
        when (code) {
            REQ_PERM_CAPTURE -> if (ok) beginCapture() else notifyCapture("error", "需要“录音”权限才能抓手机声音（请到系统设置里允许 SoundMesh 使用麦克风）")
            REQ_PERM_WEB -> {
                val r = pendingWebPermission; pendingWebPermission = null
                if (ok) r?.grant(r.resources) else r?.deny()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_PROJECTION -> {
                if (resultCode != RESULT_OK || data == null) { notifyCapture("denied", ""); return }
                val i = Intent(this, CaptureService::class.java).putExtra("code", resultCode).putExtra("data", data)
                startForegroundService(i)
            }
            REQ_FILE -> {
                val cb = fileCallback; fileCallback = null
                if (cb == null) return
                if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
                val uris = mutableListOf<Uri>()
                data.clipData?.let { c -> for (k in 0 until c.itemCount) uris.add(c.getItemAt(k).uri) }
                if (uris.isEmpty()) data.data?.let { uris.add(it) }
                cb.onReceiveValue(uris.toTypedArray())
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // 注意：不调用 web.onPause()，切到别的 App 时 SoundMesh 页面照常运行

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // 返回键：退到后台继续运行；真的要关闭时再确认
        AlertDialog.Builder(this)
            .setMessage("要关闭 SoundMesh 吗？关闭后所有设备都会停止播放。\n（只想用别的 App 的话，按主页键就行，SoundMesh 会在后台继续）")
            .setPositiveButton("关闭") { _, _ -> stopService(Intent(this, CaptureService::class.java)); finish() }
            .setNegativeButton("留在后台") { _, _ -> moveTaskToBack(true) }
            .show()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        if (isFinishing) stopService(Intent(this, CaptureService::class.java))
        web.destroy()
        super.onDestroy()
    }

    /** 给网页调用的接口：window.SoundMeshApp */
    inner class Bridge {
        @JavascriptInterface fun startCapture() = runOnUiThread { beginCapture() }
        @JavascriptInterface fun stopCapture() = runOnUiThread { stopService(Intent(this@MainActivity, CaptureService::class.java)) }
        @JavascriptInterface fun read(): String = PcmQueue.drainBase64()
        @JavascriptInterface fun info(): String = JSONObject()
            .put("capturing", CaptureService.running)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("model", Build.MODEL)
            .put("version", BuildConfigCompat.versionName(this@MainActivity))
            .toString()
    }
}

object BuildConfigCompat {
    fun versionName(a: Activity): String = try {
        a.packageManager.getPackageInfo(a.packageName, 0).versionName ?: "?"
    } catch (_: Throwable) { "?" }
}
