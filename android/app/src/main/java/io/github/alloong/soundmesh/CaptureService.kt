package io.github.alloong.soundmesh

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.Process

/**
 * 前台服务：抓手机上其他 App 正在播放的声音（Android 10+ 的“播放内容录制”），
 * 放进 PcmQueue 给 SoundMesh 页面。通知栏常驻，锁屏/切到别的 App 也继续工作。
 */
class CaptureService : Service() {
    companion object {
        @Volatile var running = false
        private const val CHANNEL = "capture"
        private const val NOTIF_ID = 1
        const val ACTION_STOP = "stop"
    }

    private var projection: MediaProjection? = null
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        if (running) return START_NOT_STICKY

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "SoundMesh 抓声音", NotificationManager.IMPORTANCE_LOW))
        // Android 14 规定：必须先成为前台服务，才能拿到录屏/录音授权
        startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)

        try {
            val code = intent?.getIntExtra("code", 0) ?: 0
            val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("data", Intent::class.java)
                                else @Suppress("DEPRECATION") intent?.getParcelableExtra("data")
            requireNotNull(data) { "没有拿到授权" }
            val mpm = getSystemService(MediaProjectionManager::class.java)
            val proj = mpm.getMediaProjection(code, data) ?: error("没有拿到授权")
            projection = proj
            proj.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() { stopSelf() }
            }, Handler(Looper.getMainLooper()))
            startRecording(proj)
            MainActivity.notifyCapture("on", "")
        } catch (e: Throwable) {
            MainActivity.notifyCapture("error", e.message ?: e.toString())
            stopSelf()
        }
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission") // 录音权限在 MainActivity 里先申请过了
    private fun startRecording(proj: MediaProjection) {
        val cfg = AudioPlaybackCaptureConfiguration.Builder(proj)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()
        val fmt = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(48000)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build()
        val minBuf = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord.Builder()
            .setAudioFormat(fmt)
            .setBufferSizeInBytes(maxOf(minBuf * 4, 48000 * 4 / 5)) // 至少 200ms 缓冲
            .setAudioPlaybackCaptureConfig(cfg)
            .build()
        check(rec.state == AudioRecord.STATE_INITIALIZED) { "录音初始化失败" }
        rec.startRecording()
        record = rec
        PcmQueue.reset()
        running = true

        wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SoundMesh:capture").apply { acquire() }
        @Suppress("DEPRECATION")
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifi = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(mode, "SoundMesh:wifi").apply { acquire() }

        thread = Thread {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val buf = ByteArray(960 * 4) // 20ms
            while (running) {
                val n = record?.read(buf, 0, buf.size) ?: -1
                if (n > 0) PcmQueue.push(buf, n) else if (n < 0) break
            }
        }.apply { name = "SoundMeshCapture"; start() }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, CaptureService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle("SoundMesh 正在播放到其他设备")
            .setContentText("手机上播放的声音会同步送到连接的设备")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止", stop).build())
            .build()
    }

    override fun onDestroy() {
        running = false
        try { record?.stop() } catch (_: Throwable) {}
        try { thread?.join(500) } catch (_: Throwable) {}
        try { record?.release() } catch (_: Throwable) {}
        record = null
        try { projection?.stop() } catch (_: Throwable) {}
        projection = null
        try { wake?.release() } catch (_: Throwable) {}
        try { wifi?.release() } catch (_: Throwable) {}
        MainActivity.notifyCapture("off", "")
        super.onDestroy()
    }
}
