package mn.basu.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import mn.basu.app.MainActivity
import mn.basu.app.R
import mn.basu.app.calls.Calls

/**
 * What Firebase brings: a call ringing (`type: call`) or a message for the
 * tray (`type: message`). Both are data messages, drawn here, so a phone
 * shows them the same way whether Basu was open, in the background or
 * closed.
 */
class Messaging : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    Fcm.tokenChanged(token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    when (data["type"]) {
      "call" -> Rings.show(applicationContext, data)
      "message" -> Tray.show(applicationContext, data)
    }
  }
}

private fun Context.mayNotify(): Boolean =
  Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

/**
 * A call ringing with the app closed: the phone's incoming-call notification,
 * full screen on a locked phone where Android allows it, with «Татгалзах» and
 * «Авах». It goes by itself after the 45 seconds the server rings for; the
 * server leaves a missed call in the inbox.
 */
object Rings {
  private const val CHANNEL = "rings"
  const val EXTRA_CALL = "mn.basu.app.call"
  const val EXTRA_ANSWER = "mn.basu.app.call.answer"

  fun show(context: Context, data: Map<String, String>) {
    val callId = data["call_id"] ?: return
    // On screen, the app rings itself (Calls listens while it is open).
    if (Fcm.foreground || !context.mayNotify()) return
    val caller = data["caller_name"]?.ifBlank { null } ?: "Basu"
    val about = data["about"].orEmpty()
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Ирж буй дуудлага", NotificationManager.IMPORTANCE_HIGH).apply {
          setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
          )
          enableVibration(true)
          vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
        },
      )
    }
    val open = PendingIntent.getActivity(
      context,
      callId.hashCode(),
      Intent(context, MainActivity::class.java).putExtra(EXTRA_CALL, callId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val answer = PendingIntent.getActivity(
      context,
      callId.hashCode() + 1,
      Intent(context, MainActivity::class.java).putExtra(EXTRA_CALL, callId).putExtra(EXTRA_ANSWER, true)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val decline = PendingIntent.getBroadcast(
      context,
      callId.hashCode() + 2,
      Intent(context, DeclineReceiver::class.java).putExtra(EXTRA_CALL, callId),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val person = Person.Builder().setName(caller).setImportant(true).build()
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_call)
      .setContentTitle(caller)
      .setContentText(listOf(about, "Танд залгаж байна").filter { it.isNotBlank() }.joinToString(" · "))
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(true)
      .setTimeoutAfter(45_000)
      .setContentIntent(open)
      .setFullScreenIntent(open, true)
      .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
      .build()
    runCatching { NotificationManagerCompat.from(context).notify(TAG, callId.hashCode(), notification) }
  }

  fun cancel(context: Context, callId: String) {
    NotificationManagerCompat.from(context).cancel(TAG, callId.hashCode())
  }

  private const val TAG = "ring"
}

/** «Татгалзах» on the ringing notification: declined on the server, without opening the app. */
class DeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(Rings.EXTRA_CALL) ?: return
    Rings.cancel(context, callId)
    val pending = goAsync()
    Calls.decline(callId) { pending.finish() }
  }
}

/**
 * Order news in the tray: the title, the words, and a tap that opens the
 * order it is about — an идэш in the winter-meat app — or the inbox.
 */
object Tray {
  private const val CHANNEL = "updates"

  fun show(context: Context, data: Map<String, String>) {
    if (!context.mayNotify()) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Захиалгын мэдээ", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val subjectId = data["subject_id"]?.ifBlank { null }
    val link = when {
      data["subject"] == "idesh" && subjectId != null -> "basu://idesh/$subjectId"
      data["subject"] == "order" && subjectId != null -> "basu://order/$subjectId"
      else -> "basu://notifications"
    }
    val open = PendingIntent.getActivity(
      context,
      link.hashCode(),
      Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val body = data["body"].orEmpty()
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle(data["title"]?.ifBlank { null } ?: "Basu")
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setContentIntent(open)
      .apply { data["badge"]?.toIntOrNull()?.let(::setNumber) }
      .build()
    // One per template and subject, as iOS collapses them: a newer word on the same order replaces the older.
    val key = "${data["template"]}:${subjectId ?: data["body"]}"
    runCatching { NotificationManagerCompat.from(context).notify("message", key.hashCode(), notification) }
  }
}
