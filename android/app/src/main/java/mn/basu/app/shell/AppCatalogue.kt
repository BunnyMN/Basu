package mn.basu.app.shell

/**
 * What is inside Basu.
 *
 * An app is a web page. The shell is native — launcher, wallet, inbox,
 * profile — and every tile opens a page from the same server the shell talks
 * to, inside `ServiceView`, signed in as the shell's guest. Adding an app is
 * one entry here with its path.
 *
 * The tiles never rearrange themselves: no folders and no most-recently-used
 * reordering. Only what is built is listed — nothing is advertised early.
 */
data class LauncherApp(
  val id: String,
  val name: String,
  /** A few lower-case words — «урьдчилан захиалах». The tile sets them as a line, capital first. */
  val tag: String,
  /** The supplied render's name (`design.art`). */
  val art: String,
  /** Where the page lives on the server — `/dine`. */
  val path: String,
) {
  val destination: Destination get() = Destination.App(id, path)

  /** The page, opened on one thing the guest already has — `/dine?order=…`. */
  fun destination(order: String): Destination = Destination.App(id, "$path?order=$order")

  /** The tag as the tile prints it: a line under the name, capital first. */
  val line: String get() = tag.replaceFirstChar { it.uppercase() }
}

object AppCatalogue {
  val food = LauncherApp("food", "Хоол", "урьдчилан захиалах", "food-tile", "/dine")
  val idesh = LauncherApp("idesh", "Идэш", "бүтэн мал, кг-аар мах", "idesh-tile", "/idesh")

  /**
   * The supplier's own side of the second app, for the few guests who are
   * one. Not in `shipped` — it is on the launcher only for them.
   */
  val supplier = LauncherApp("supplier", "Нийлүүлэгч", "зараа удирдах", "supplier-tile", "/supplier")

  /** What everybody has, in the order the product fixes. */
  val shipped = listOf(food, idesh)
}

sealed interface Destination {
  /** An app: its id from `AppCatalogue`, and the page to open — `/dine`, or `/dine?order=…`. */
  data class App(val id: String, val path: String) : Destination

  /** Reached from the bell, and pushed over the launcher rather than given a tab. */
  data object Inbox : Destination
}

/** The four the tab bar carries. Apps are never tabs — they are tiles. */
enum class ShellTab(val title: String, val tag: String) {
  Home("Нүүр", "home"),
  Orders("Захиалга", "orders"),
  Wallet("Түрийвч", "wallet"),
  Profile("Профайл", "profile"),
}
