import BasuKit
import SwiftUI
import WebKit

/**
 An app inside Basu: a web page from the shell's own server, full screen.

 The shell is native and the apps are not. That is the division of labour the
 whole project rests on: the launcher, the wallet, the inbox, the profile and
 the lock screen are Swift, because they are what a person sees before they
 have chosen anything and they have to feel like the phone. Everything after
 the choice — the map, the menu, the sitting, the status — is the web page at
 `/dine`, the same one the browser gets, verified by `npm run smoke` and
 `pages.test.ts`. Writing it a second time in Swift meant every fix landing
 twice or, more often, once.

 Three things cross the line between the two, and only three:

 - **The session.** The shell signs the guest in and keeps the token in the
   keychain. Before the page loads, the token is put where the page already
   looks — `localStorage['basu.guest']`. The page never signs anybody in on
   its own: when it needs a guest and has none it asks (`signIn` below), the
   shell shows its own sheet, and the token arrives the same way.
 - **The way out.** The page's `‹ Basu` link goes to `/`, which in a browser
   is the web launcher. Here it is this screen's parent, so the navigation is
   cancelled and the stack pops instead. There is no second back button.
 - **What changed.** The page tells the shell when an order moved, so the
   ИДЭВХТЭЙ card, the lock screen and the widget catch up at once rather than
   on the next poll. The poll is still there for what the page cannot know.

 Nothing else. The page does not know it is inside an app beyond the one
 message handler, and a page that works in Safari works here.
 */
struct ServiceView: View {
  let app: String
  let path: String
  let back: () -> Void

  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @State private var page = ServicePage()
  @State private var signingIn = false

  var body: some View {
    ZStack(alignment: .top) {
      LinearGradient.ground.ignoresSafeArea()

      ServiceWeb(page: page)
        .accessibilityIdentifier("service.\(app)")

      if page.unreachable {
        OfflineBanner {
          await model.retry()
          page.reload()
        }
        .padding(.horizontal, BasuMetric.screenPadding)
        .padding(.top, 8)
        .transition(.opacity)
      }
    }
    .toolbarVisibility(.hidden, for: .navigationBar)
    // Whatever happened in the sheet, the page is waiting for an answer.
    .sheet(isPresented: $signingIn, onDismiss: { page.deliver(token: session.token) }) {
      SignInSheet()
    }
    .onAppear {
      page.home = back
      page.signIn = { signingIn = true }
      page.changed = { Task { await model.refreshLive() } }
      page.load(Endpoint.base, path: path, token: session.token)
    }
    .onChange(of: session.token) { _, token in
      page.deliver(token: token)
    }
    .task {
      // The card outside the page keeps up with the page. Five seconds is the
      // web status sheet's own cadence; there is nothing to gain by racing it.
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5))
        await model.refreshLive()
      }
    }
  }
}

/// The web view, as SwiftUI sees it. All the behaviour is on `ServicePage`.
private struct ServiceWeb: UIViewRepresentable {
  let page: ServicePage

  func makeUIView(context: Context) -> WKWebView { page.webView }
  func updateUIView(_ webView: WKWebView, context: Context) {}
}

/**
 One page, and the three messages it can send.

 Kept outside the view because a `WKWebView` is expensive to make and must not
 be remade on every state change, and because the delegate callbacks need a
 stable object to land on.
 */
@MainActor
@Observable
final class ServicePage: NSObject {
  /// The server could not be reached. Said out loud, not left as a white page.
  private(set) var unreachable = false

  var home: (() -> Void)?
  var signIn: (() -> Void)?
  var changed: (() -> Void)?

  private var base = Endpoint.base
  private var pending: URLRequest?

  /// The page's side of the bridge: `window.webkit.messageHandlers.basu`.
  static let handler = "basu"

  let webView: WKWebView

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.allowsBackForwardNavigationGestures = false
    #if DEBUG
      // Safari → Develop → the simulator, for the page as it is here.
      webView.isInspectable = true
    #endif
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    configuration.userContentController.add(Relay(self), name: Self.handler)
  }

  /// Put the session where the page looks, then open it.
  func load(_ base: URL, path: String, token: String?) {
    self.base = base
    let controller = webView.configuration.userContentController
    controller.removeAllUserScripts()
    // Before any of the page's own scripts run, so its first request already
    // carries the shell's guest rather than nobody.
    controller.addUserScript(WKUserScript(
      source: Self.sessionScript(token: token),
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true,
    ))
    guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    pending = request
    webView.load(request)
  }

  func reload() {
    unreachable = false
    if let pending { webView.load(pending) } else { webView.reload() }
  }

  /// The answer to `signIn`: the token, or `nil` when the sheet was dismissed
  /// without one. Either way the page stops waiting.
  func deliver(token: String?) {
    let script = Self.sessionScript(token: token)
      + "\nif (typeof window.__basuSignedIn === 'function') window.__basuSignedIn(\(Self.literal(token)));"
    webView.evaluateJavaScript(script)
  }

  private static func sessionScript(token: String?) -> String {
    """
    (function () {
      try {
        var t = \(literal(token));
        if (t) localStorage.setItem('basu.guest', t); else localStorage.removeItem('basu.guest');
      } catch (e) {}
    })();
    """
  }

  /// A Swift string as a JavaScript one, `null` for none.
  private static func literal(_ value: String?) -> String {
    guard let value, let data = try? JSONSerialization.data(withJSONObject: [value]),
          let text = String(data: data, encoding: .utf8)
    else { return "null" }
    // `["…"]` → `"…"`
    return String(text.dropFirst().dropLast())
  }

  /// Whether a navigation is going somewhere the shell owns.
  private func isHome(_ url: URL) -> Bool {
    url.host == base.host && url.port == base.port && (url.path.isEmpty || url.path == "/")
  }

  private func isOurs(_ url: URL) -> Bool {
    url.host == base.host && url.port == base.port
  }

  // MARK: the page's messages

  fileprivate func received(_ body: Any) {
    guard let message = body as? [String: Any], let type = message["type"] as? String else { return }
    switch type {
    case "signIn": signIn?()
    case "orders": changed?()
    case "home": home?()
    default: break
    }
  }

  /// The content controller keeps its handlers strongly, so a page that held
  /// itself through it would never be freed. This holds it weakly instead.
  private final class Relay: NSObject, WKScriptMessageHandler {
    weak var page: ServicePage?
    init(_ page: ServicePage) { self.page = page }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      let body = message.body
      Task { @MainActor [weak page] in page?.received(body) }
    }
  }
}

extension ServicePage: WKNavigationDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
  ) async -> WKNavigationActionPolicy {
    guard let url = action.request.url else { return .allow }

    // `‹ Basu` goes to `/`, which is the launcher — this screen's parent.
    if isHome(url) {
      home?()
      return .cancel
    }

    // A link out of the page — the tile attribution, a restaurant's site —
    // is Safari's, not this screen's. So is anything asking for a new window.
    let external = ["http", "https"].contains(url.scheme ?? "") && !isOurs(url)
    if external || action.targetFrame == nil {
      await UIApplication.shared.open(url)
      return .cancel
    }
    return .allow
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // A refused connection does not always arrive as a failure. On iOS 26 the
    // web view answers it by finishing `about:blank` instead, with no error
    // callback at all — so "the page that finished is not the one asked for"
    // is the outage, and is the only signal there reliably is.
    if let url = webView.url, isOurs(url) {
      unreachable = false
    } else {
      unreachable = true
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // A cancelled load is this file's own doing (see above), not an outage.
    if (error as NSError).code == NSURLErrorCancelled { return }
    unreachable = true
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code == NSURLErrorCancelled { return }
    unreachable = true
  }
}

extension ServicePage: WKUIDelegate {
  /// `target="_blank"` — hand it to Safari rather than silently doing nothing.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures,
  ) -> WKWebView? {
    if let url = action.request.url { UIApplication.shared.open(url) }
    return nil
  }
}
