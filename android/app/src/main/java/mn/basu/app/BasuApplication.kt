package mn.basu.app

import android.app.Application
import mn.basu.app.core.Api
import mn.basu.app.core.AppLock
import mn.basu.app.core.AppModel
import mn.basu.app.core.Platform
import mn.basu.app.core.PushRegistrar
import mn.basu.app.core.Session

/**
 * Basu — a launcher, and the things that arrive inside it.
 *
 * The shell is native and the apps are not. Every tile opens a web page from
 * the shell's own server inside `ServiceView`, signed in as the shell's
 * guest; the shell keeps the launcher, the orders, the wallet, the inbox and
 * the profile. The same product as the iOS app in `ios/`, screen for screen.
 */
class BasuApplication : Application() {
  lateinit var api: Api
  lateinit var session: Session
  lateinit var model: AppModel
  lateinit var platform: Platform
  lateinit var lock: AppLock
  lateinit var push: PushRegistrar

  override fun onCreate() {
    super.onCreate()
    api = Api()
    session = Session(api, this)
    model = AppModel(api, session, this)
    platform = Platform(api, session, this)
    lock = AppLock(this)
    push = PushRegistrar(this)
  }
}
