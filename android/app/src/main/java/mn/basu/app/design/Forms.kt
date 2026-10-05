package mn.basu.app.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * The parts every form in the shell is made of: the way in, and the profile's
 * own sheets — a name, an address, a password.
 *
 * One field, one code input, one button and one way of saying no. Fields are
 * the surface with a `line2` edge that turns to the ink when typed in; the
 * one button is a crimson capsule (`PrimaryButton`); a refusal is crimson
 * words under the field it is about.
 */

/** The chrome of a field: its mark, what is typed, and an edge that lights when active. */
@Composable
fun AuthField(
  symbol: ImageVector,
  active: Boolean,
  modifier: Modifier = Modifier,
  tap: () -> Unit = {},
  content: @Composable RowScope.() -> Unit,
) {
  val shape = RoundedCornerShape(BasuMetric.control)
  Row(
    modifier
      .fillMaxWidth()
      .defaultMinSize(minHeight = BasuMetric.controlHeight)
      .background(BasuColor.surface, shape)
      .border(if (active) 2.dp else BasuMetric.hairline, if (active) BasuColor.focus else BasuColor.line2, shape)
      .plainClick(role = null, onClick = tap)
      .padding(horizontal = 16.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(Modifier.widthIn(min = 22.dp), contentAlignment = Alignment.Center) {
      Symbol(symbol, if (active) BasuColor.ink else BasuColor.ink3, size = 20.dp)
    }
    content()
  }
}

/**
 * A whole field: the chrome above with a text field in it. `trailing` is for
 * the eye beside a password. The placeholder is `ink3` — readable on charcoal.
 */
@Composable
fun BasuTextField(
  value: String,
  onValueChange: (String) -> Unit,
  placeholder: String,
  symbol: ImageVector,
  modifier: Modifier = Modifier,
  focus: FocusRequester = remember { FocusRequester() },
  keyboardType: KeyboardType = KeyboardType.Text,
  capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
  imeAction: ImeAction = ImeAction.Done,
  onImeAction: () -> Unit = {},
  visualTransformation: VisualTransformation = VisualTransformation.None,
  enabled: Boolean = true,
  tag: String? = null,
  trailing: (@Composable () -> Unit)? = null,
) {
  var active by remember { mutableStateOf(false) }
  AuthField(symbol, active, modifier, tap = { runCatching { focus.requestFocus() } }) {
    Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
      if (value.isEmpty()) {
        Text(placeholder, color = BasuColor.ink3, style = sans(16, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier
          .fillMaxWidth()
          .focusRequester(focus)
          .onFocusChanged { active = it.isFocused }
          .semantics { contentDescription = placeholder }
          .then(if (tag != null) Modifier.testTag(tag) else Modifier),
        enabled = enabled,
        singleLine = true,
        textStyle = sans(16, FontWeight.Medium).copy(color = BasuColor.ink),
        cursorBrush = SolidColor(BasuColor.ink),
        keyboardOptions = KeyboardOptions(
          capitalization = capitalization,
          autoCorrectEnabled = false,
          keyboardType = keyboardType,
          imeAction = imeAction,
        ),
        keyboardActions = KeyboardActions(onAny = { onImeAction() }),
        visualTransformation = visualTransformation,
      )
    }
    trailing?.invoke()
  }
}

/** A password, hidden or shown — shown, it is not "helped": no capital, no autocorrect. */
@Composable
fun PasswordField(
  title: String,
  text: String,
  onChange: (String) -> Unit,
  reveal: Boolean,
  symbol: ImageVector,
  modifier: Modifier = Modifier,
  focus: FocusRequester = remember { FocusRequester() },
  imeAction: ImeAction = ImeAction.Done,
  onImeAction: () -> Unit = {},
  tag: String? = null,
  trailing: (@Composable () -> Unit)? = null,
) {
  BasuTextField(
    value = text,
    onValueChange = onChange,
    placeholder = title,
    symbol = symbol,
    modifier = modifier,
    focus = focus,
    keyboardType = KeyboardType.Password,
    imeAction = imeAction,
    onImeAction = onImeAction,
    visualTransformation = if (reveal) VisualTransformation.None else PasswordVisualTransformation('•'),
    tag = tag,
    trailing = trailing,
  )
}

/** The eye beside a password. A whole thumb's worth of target. */
@Composable
fun RevealButton(reveal: Boolean, onToggle: () -> Unit) {
  Box(
    Modifier
      .size(BasuMetric.minTarget)
      .plainClick(onClick = onToggle)
      .semantics { contentDescription = if (reveal) "Нууц үгийг нуух" else "Нууц үгийг харуулах" },
    contentAlignment = Alignment.Center,
  ) {
    Symbol(if (reveal) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, BasuColor.ink3, size = 20.dp)
  }
}

/**
 * Six digits in six boxes. The boxes are drawn; the typing goes to one plain
 * field under them, so pasting and the keyboard's own code suggestion see an
 * ordinary text field.
 */
@Composable
fun CodeInput(
  code: String,
  onChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  focus: FocusRequester = remember { FocusRequester() },
  tag: String = "code",
) {
  var typing by remember { mutableStateOf(false) }
  BasicTextField(
    value = code,
    onValueChange = { typed -> onChange(typed.filter(Char::isDigit).take(6)) },
    modifier = modifier
      .fillMaxWidth()
      .focusRequester(focus)
      .onFocusChanged { typing = it.isFocused }
      .semantics { contentDescription = "Имэйлд ирсэн код" }
      .testTag(tag),
    singleLine = true,
    textStyle = sans(16).copy(color = Color.Transparent),
    cursorBrush = SolidColor(Color.Transparent),
    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
    decorationBox = {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(6) { index ->
          val shape = RoundedCornerShape(BasuMetric.control)
          val next = typing && index == minOf(code.length, 5)
          Box(
            Modifier
              .weight(1f)
              .height(BasuMetric.controlHeight + 6.dp)
              .background(BasuColor.surface, shape)
              .border(if (next) 2.dp else BasuMetric.hairline, if (next) BasuColor.focus else BasuColor.line2, shape),
            contentAlignment = Alignment.Center,
          ) {
            Text(code.getOrNull(index)?.toString() ?: "", color = BasuColor.ink, style = display(28))
          }
        }
      }
    },
  )
}

/** The small print under a field: what happens next, and where the code goes. */
@Composable
fun Note(text: String, modifier: Modifier = Modifier) {
  Text(text, modifier.fillMaxWidth(), color = BasuColor.ink3, style = sans(13, FontWeight.Medium))
}

/** A refusal, said under the field it is about — never at the foot of the card. */
@Composable
fun TroubleNote(
  text: String,
  modifier: Modifier = Modifier,
  id: String = "signin.trouble",
  extra: (@Composable ColumnScope.() -> Unit)? = null,
) {
  val shape = RoundedCornerShape(BasuMetric.control)
  Column(
    modifier
      .fillMaxWidth()
      .background(BasuColor.stopSoft, shape)
      .border(BasuMetric.hairline, BasuColor.stopLine, shape)
      .padding(14.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Symbol(Icons.Outlined.ErrorOutline, BasuColor.accentInk, size = 18.dp)
      Text(text, Modifier.weight(1f).testTag(id), color = BasuColor.accentInk, style = sans(14, FontWeight.SemiBold))
    }
    extra?.invoke(this)
  }
}

/** A row on a form that is not typed in: the address a code will go to. */
@Composable
fun AuthValue(symbol: ImageVector, label: String, value: String, modifier: Modifier = Modifier) {
  val shape = RoundedCornerShape(BasuMetric.control)
  Row(
    modifier
      .fillMaxWidth()
      .defaultMinSize(minHeight = BasuMetric.controlHeight)
      .background(BasuColor.surface, shape)
      .border(BasuMetric.hairline, BasuColor.line, shape)
      .padding(horizontal = 16.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Box(Modifier.widthIn(min = 22.dp), contentAlignment = Alignment.Center) {
      Symbol(symbol, BasuColor.ink3, size = 20.dp)
    }
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(label, color = BasuColor.ink3, style = sans(12, FontWeight.SemiBold))
      Text(value, color = BasuColor.ink, style = sans(16, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

/** A quiet text button under a card — «Код дахин авах» — at a thumb's height. */
@Composable
fun QuietLink(title: String, modifier: Modifier = Modifier, enabled: Boolean = true, action: () -> Unit) {
  Box(
    modifier.defaultMinSize(minHeight = BasuMetric.minTarget).plainClick(enabled = enabled, onClick = action),
    contentAlignment = Alignment.Center,
  ) {
    Text(title, color = if (enabled) BasuColor.ink else BasuColor.ink3, style = sans(14, FontWeight.Bold), textAlign = TextAlign.Center)
  }
}
