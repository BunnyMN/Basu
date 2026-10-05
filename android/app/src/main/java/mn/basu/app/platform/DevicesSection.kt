package mn.basu.app.platform

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.LaptopMac
import androidx.compose.material.icons.outlined.QuestionMark
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.TabletMac
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import mn.basu.app.core.DeviceSession
import mn.basu.app.core.Format
import mn.basu.app.core.LocalPlatform
import mn.basu.app.core.Session
import mn.basu.app.design.BasuAlert
import mn.basu.app.design.BasuColor
import mn.basu.app.design.BasuMetric
import mn.basu.app.design.BasuSheet
import mn.basu.app.design.Chevron
import mn.basu.app.design.Hairline
import mn.basu.app.design.QuietLink
import mn.basu.app.design.SectionLabel
import mn.basu.app.design.Symbol
import mn.basu.app.design.card
import mn.basu.app.design.plainClick
import mn.basu.app.design.pressable
import mn.basu.app.design.sans

/** How many other devices the profile shows before «Бүгдийг харах». */
private const val SHOWN = 3

/**
 * «Нэвтэрсэн төхөөрөмж»: where this account is signed in, and the way out of
 * each.
 *
 * Not a feature until a phone is lost, and then the only one that matters. It
 * is here so that day needs nobody's help: no email, no support queue, no
 * waiting sixty days for a token to expire on its own.
 *
 * The list used to be every session, one row each, which after a few weeks of
 * signing in and out was a column of identical rows nobody could read. Now
 * this phone comes first and says so, the three others seen most recently
 * follow, and the rest wait behind «Бүгдийг харах». Signing out on a phone
 * ends its session on the server too (`Platform.signOut`), so the list no
 * longer grows by itself.
 *
 * `confirmOthers` is ProfileView's own confirmation — asked before everywhere
 * else goes.
 */
@Composable
fun DevicesSection(confirmOthers: () -> Unit) {
  val platform = LocalPlatform.current
  var showingAll by remember { mutableStateOf(false) }

  val current = platform.sessions.firstOrNull { it.current }
  val others = platform.sessions.filter { !it.current }
  if (platform.sessions.isEmpty()) return

  Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      SectionLabel("Нэвтэрсэн төхөөрөмж", Modifier.alignByBaseline())
      Text(
        "${platform.sessions.size}",
        Modifier.alignByBaseline(),
        color = BasuColor.ink3,
        style = sans(12, FontWeight.Bold).copy(fontFeatureSettings = "tnum"),
      )
    }

    Column(Modifier.fillMaxWidth().card()) {
      if (current != null) DeviceRow(current)
      others.take(SHOWN).forEachIndexed { index, device ->
        key(device.id) {
          if (current != null || index > 0) Hairline()
          DeviceRow(device) { platform.signOutDevice(device) }
        }
      }
      if (others.size > SHOWN) {
        Hairline()
        Row(
          Modifier
            .fillMaxWidth()
            .testTag("profile.devices.all")
            .plainClick { showingAll = true }
            .padding(horizontal = 16.dp, vertical = 14.dp),
          horizontalArrangement = Arrangement.spacedBy(12.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            "Бүгдийг харах",
            Modifier.weight(1f).padding(end = 8.dp),
            color = BasuColor.ink,
            style = sans(16, FontWeight.SemiBold),
          )
          Text(
            "${others.size}",
            color = BasuColor.ink3,
            style = sans(14, FontWeight.Bold).copy(fontFeatureSettings = "tnum"),
          )
          Chevron(BasuColor.ink3, size = 12.dp)
        }
      }
    }

    if (others.isNotEmpty()) {
      OthersOutButton(others.size, Modifier.testTag("profile.revokeothers"), confirmOthers)
      Text(
        "Танихгүй төхөөрөмж харагдвал тэр даруй гаргаарай.",
        color = BasuColor.ink3,
        style = sans(13, FontWeight.Medium),
      )
    }
  }

  if (showingAll) AllDevicesSheet(onDismiss = { showingAll = false })
}

/** Every other device, for when there are more than the profile shows. */
@Composable
private fun AllDevicesSheet(onDismiss: () -> Unit) {
  val platform = LocalPlatform.current
  val scope = rememberCoroutineScope()
  var confirming by remember { mutableStateOf(false) }
  val others = platform.sessions.filter { !it.current }

  BasuSheet(onDismiss = onDismiss) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp).height(BasuMetric.minTarget), contentAlignment = Alignment.Center) {
      Text("Бусад төхөөрөмж", color = BasuColor.ink, style = sans(17, FontWeight.Bold))
      QuietLink("Болсон", Modifier.align(Alignment.CenterEnd).padding(horizontal = 12.dp), action = onDismiss)
    }
    Column(
      Modifier
        .fillMaxWidth()
        .verticalScroll(rememberScrollState())
        .padding(BasuMetric.screenPadding),
      verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
      if (others.isNotEmpty()) {
        Column(Modifier.fillMaxWidth().card()) {
          others.forEachIndexed { index, device ->
            key(device.id) {
              if (index > 0) Hairline()
              DeviceRow(device) { platform.signOutDevice(device) }
            }
          }
        }
        OthersOutButton(others.size) { confirming = true }
      } else {
        Text("Энэ утаснаас өөр хаана ч нэвтрээгүй байна.", color = BasuColor.ink2, style = sans(14))
      }
    }
  }

  // An alert, as on the profile: it always draws «Болих».
  if (confirming) {
    BasuAlert(
      title = "Бусад бүх төхөөрөмжөөс гарах уу?",
      message = "Энэ утас нэвтэрсэн хэвээр үлдэнэ.",
      confirm = "Гаргах",
      destructive = true,
      cancel = "Болих",
      onConfirm = {
        confirming = false
        scope.launch { platform.signOutOtherDevices() }
      },
      onDismiss = { confirming = false },
    )
  }
}

/**
 * One device: what it is, when it was last seen, and the way to end it.
 * `revoke` is null for this phone — it leaves by «Гарах», not from its own row.
 */
@Composable
private fun DeviceRow(device: DeviceSession, revoke: (suspend () -> Unit)? = null) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var revoking by remember { mutableStateOf(false) }
  val name = device.shownName(context)

  Row(
    Modifier
      .fillMaxWidth()
      .testTag("profile.device")
      .padding(horizontal = 16.dp, vertical = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier.size(40.dp).background(BasuColor.surface3, RoundedCornerShape(BasuMetric.row)),
      contentAlignment = Alignment.Center,
    ) {
      Symbol(device.symbol(context), BasuColor.ink2, size = 20.dp)
    }
    Column(Modifier.weight(1f).padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(
        name,
        color = BasuColor.ink,
        style = sans(16, if (device.current) FontWeight.Bold else FontWeight.SemiBold),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      if (device.current) {
        // Good, so the ink and a check — never a green dot.
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
          Symbol(Icons.Outlined.Check, BasuColor.ink2, size = 13.dp)
          Text("Энэ утас · одоо идэвхтэй", color = BasuColor.ink2, style = sans(13, FontWeight.SemiBold))
        }
      } else {
        Text(
          "Сүүлд ${Format.seen(device.lastSeenAt ?: device.createdAt)}",
          color = BasuColor.ink3,
          style = sans(13, FontWeight.Medium),
        )
      }
    }
    if (revoke != null) {
      Box(
        Modifier
          .defaultMinSize(minWidth = 64.dp, minHeight = BasuMetric.minTarget)
          .plainClick(enabled = !revoking) {
            scope.launch {
              revoking = true
              try {
                revoke()
              } finally {
                revoking = false
              }
            }
          }
          .semantics { contentDescription = "$name-ийг гаргах" }
          .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
      ) {
        // Crimson words, the way every Basu screen says «take this away».
        if (revoking) {
          CircularProgressIndicator(Modifier.size(16.dp), color = BasuColor.accentInk, strokeWidth = 2.dp)
        } else {
          Text("Гаргах", color = BasuColor.accentInk, style = sans(14, FontWeight.Bold))
        }
      }
    }
  }
}

/**
 * «Бусад N төхөөрөмжөөс гаргах»: the panic button — crimson words, and an
 * alert that asks before anybody is signed out.
 */
@Composable
private fun OthersOutButton(count: Int, modifier: Modifier = Modifier, action: () -> Unit) {
  Row(
    modifier
      .fillMaxWidth()
      .border(BasuMetric.hairline, BasuColor.stopLine, CircleShape)
      .clip(CircleShape)
      .pressable(onClick = action)
      .defaultMinSize(minHeight = BasuMetric.buttonHeight)
      .padding(horizontal = 16.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Symbol(Icons.AutoMirrored.Outlined.Logout, BasuColor.accentInk, size = 18.dp)
    Text(
      if (count == 1) "Нөгөө төхөөрөмжөөс гаргах" else "Бусад $count төхөөрөмжөөс гаргах",
      color = BasuColor.accentInk,
      style = sans(15, FontWeight.Bold),
    )
  }
}

/**
 * What a person calls this device. This phone always has a name, even when
 * the way it signed in — Google's round trip — gave the server none.
 */
private fun DeviceSession.shownName(context: Context): String =
  if (current && label.isNullOrEmpty()) Session.deviceName(context) else name

/** A mark for the kind of thing it is, read off the name it signed in with. */
private fun DeviceSession.symbol(context: Context): ImageVector {
  val label = (if (current && this.label.isNullOrEmpty()) Session.deviceName(context) else this.label ?: "").lowercase()
  return when {
    label.isEmpty() -> Icons.Outlined.QuestionMark
    label.contains("ipad") -> Icons.Outlined.TabletMac
    label.contains("mac") -> Icons.Outlined.LaptopMac
    label.contains("вэб") || label.contains("web") -> Icons.Outlined.Language
    label.contains("дэлгэц") || label.contains("tablet") -> Icons.Outlined.DesktopWindows
    else -> Icons.Outlined.Smartphone
  }
}
