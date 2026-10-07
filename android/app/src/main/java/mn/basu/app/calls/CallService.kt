package mn.basu.app.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import mn.basu.app.MainActivity
import mn.basu.app.R

/**
 * What keeps a call talking with the app out of sight: Android cuts the
 * microphone of an app in the background unless a foreground service says
 * it is in use, and says so to the person in a notification they can hang
 * up from. Started once the call is placed or answered, ended with it.
 */
class CallService : Service() {
  companion object {
    private const val CHANNEL = "calls"
    private const val ID = 4207
    private const val END = "mn.basu.app.calls.END"
    private const val CAMERA = "camera"

    fun start(context: Context, camera: Boolean) {
      val intent = Intent(context, CallService::class.java).putExtra(CAMERA, camera)
      runCatching { ContextCompat.startForegroundService(context, intent) }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, CallService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == END) {
      Calls.end("Дуудлага дууслаа.")
      stopSelf()
      return START_NOT_STICKY
    }
    val camera = intent?.getBooleanExtra(CAMERA, false) ?: false
    val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or (if (camera) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0)
    } else {
      0
    }
    runCatching { ServiceCompat.startForeground(this, ID, notification(), types) }
      .onFailure { stopSelf() }
    return START_NOT_STICKY
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Дуудлага", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val end = PendingIntent.getService(
      this,
      1,
      Intent(this, CallService::class.java).setAction(END),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val call = Calls.live
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_call)
      .setContentTitle(call?.peerName?.ifBlank { null } ?: "Basu")
      .setContentText(listOfNotNull(call?.about?.ifBlank { null }, "Дуудлага").joinToString(" · "))
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setContentIntent(open)
      .addAction(R.drawable.ic_call, "Таслах", end)
      .build()
  }
}
