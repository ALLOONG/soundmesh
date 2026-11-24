package io.github.alloong.soundmesh

import android.util.Base64

/**
 * 录到的声音（48kHz、16 位、立体声交错）先放在这里，网页每 10ms 来取一次。
 * 最多存 4 秒；网页一时取不及（比如切后台被拖慢）就丢掉最旧的，并记下丢到了第几帧，
 * 网页会用静音补上，时间线保持正确。
 */
object PcmQueue {
    private const val BYTES_PER_FRAME = 4
    private val lock = Any()
    private val buf = ByteArray(48000 * BYTES_PER_FRAME * 4)
    private var len = 0
    private var startFrame = 0L   // buf[0] 是第几帧

    fun reset() = synchronized(lock) { len = 0; startFrame = 0 }

    fun push(b: ByteArray, n: Int) = synchronized(lock) {
        var count = n - n % BYTES_PER_FRAME
        if (count <= 0) return@synchronized
        if (count > buf.size) count = buf.size
        if (len + count > buf.size) {
            val drop = len + count - buf.size
            System.arraycopy(buf, drop, buf, 0, len - drop)
            len -= drop
            startFrame += drop / BYTES_PER_FRAME
        }
        System.arraycopy(b, 0, buf, len, count)
        len += count
    }

    /** 返回 "起始帧号|base64"，没有新声音时返回空字符串 */
    fun drainBase64(): String = synchronized(lock) {
        if (len < BYTES_PER_FRAME) return@synchronized ""
        val s = startFrame.toString() + "|" + Base64.encodeToString(buf, 0, len, Base64.NO_WRAP)
        startFrame += len / BYTES_PER_FRAME
        len = 0
        s
    }
}
