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

 Five things cross the line between the two, and only five:

 - **The session.** The shell signs the guest in and keeps the token in the
   keychain. Before the page loads, the token is put where the page already
   looks — `localStorage['basu.guest']`. The page never signs anybody in on
   its own: when it needs a guest and has none it asks (`signIn` below), the
   shell shows its own sheet, and the token arrives the same way.
 - **The way out.** The page's `‹ Basu` link goes to `/`, which in a browser
   is the web launcher. Here it is this screen's parent, so the navigation is
   cancelled and the stack pops instead.
 - **What changed.** The page tells the shell when an order moved, so the
   ИДЭВХТЭЙ card, the lock screen and the widget catch up at once rather than
   on the next poll. The poll is still there for what the page cannot know.
   The first time something is running, it is also the moment to ask whether
   its progress may come to the lock screen (`PushAsk`) — or, for a supplier,
   the moment their counter opens.

 - **Calling.** The order page's «Апп-аар залгах» hands the order over
   (`call`), and `CallCenter` rings with the phone's own call screen. The page
   knows the shell can by `window.__basuCalls`.

 - **Paying.** A page that needs QPay hands its invoice over (`pay`) — the
   QR's text and the bank apps, raised for this sheet — and the shell's own
   `QPaySheet` takes it: the person taps their bank, pays, and is back. The
   sheet's «Төлсөн, шалгах» asks through the page, and the page says when
   the purchase is settled (`paid`) and the sheet closes. The page knows the
   shell can by `window.__basuPays`, set before it runs; a build without it
   gets QPay's page, as before.

 Nothing else. The page does not know it is inside an app beyond the one
 message handler, and a page that works in Safari works here.

 The page's own «‹ Basu» is the way back once it has drawn; until then, and
 whenever it cannot draw, the shell's own «‹ Basu» stands in that corner and a
 swipe from the edge leaves too — an app that never loaded used to leave no
 way out but force-quitting. The page runs edge to edge and pads itself with
 the safe areas (`env(safe-area-inset-*)`), so its bars meet the clock and the
 home indicator rather than a band of the shell's ground.
 */
struct ServiceView: View {
  let app: String
  let path: String
  let back: () -> Void

  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @State private var page = ServicePage()
  @State private var signingIn = false
  @State private var askingPush = false
  /// QPay's invoice the page handed over, paid in the shell's own sheet.
  @State private var paying: PayRequest?
  /// A beat after opening. A page that draws within it never shows the
  /// shell's chip or spinner at all, rather than flashing them.
  @State private var slow = false

  var body: some View {
    ZStack(alignment: .topLeading) {
      Color.bg.ignoresSafeArea()

      ServiceWeb(page: page)
        .ignoresSafeArea()
        // A page that could not be reached has nothing to show or touch: a
        // proxy's «502 Bad Gateway» showed through under the banner, and a
        // blank web view under the thumb kept the edge swipe from leaving.
        .opacity(page.unreachable ? 0 : 1)
        .allowsHitTesting(!page.unreachable)
        .accessibilityHidden(page.unreachable)
        .accessibilityIdentifier("service.\(app)")

      if !page.loaded && !page.unreachable && slow {
        ProgressView()
          .controlSize(.large)
          .tint(Color.ink3)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          // What the page has drawn so far stays touchable under it.
          .allowsHitTesting(false)
          .accessibilityLabel("Уншиж байна")
          .transition(.opacity)
      }

      if (!page.loaded && slow) || page.unreachable {
        VStack(alignment: .leading, spacing: 8) {
          HomeChip(action: back)
          if page.unreachable {
            OfflineBanner {
              await model.retry()
              page.reload()
            }
            .padding(.horizontal, BasuMetric.screenPadding)
          }
        }
        .padding(.top, 4)
        .transition(.opacity)
      }
    }
    .animation(.easeOut(duration: 0.2), value: page.loaded)
    .animation(.easeOut(duration: 0.2), value: page.unreachable)
    .animation(.easeOut(duration: 0.2), value: slow)
    .toolbarVisibility(.hidden, for: .navigationBar)
    // The stack's edge swipe, back: the page's own swipe walks its screens
    // first, and from the first one the swipe leaves the app.
    .background(InteractivePop(enabled: !page.walksItsOwnHistory))
    // Whatever happened in the sheet, the page is waiting for an answer.
    .sheet(isPresented: $signingIn, onDismiss: { page.deliver(token: session.token) }) {
      // A guest asked mid-order hears why and that nothing was lost; the
      // supplier's counter asking again has no order to speak of.
      SignInSheet(reason: isSupplier ? nil : "Захиалгаа дуусгахын тулд нэвтэрнэ үү — сонгосон зүйлс тань хэвээр үлдэнэ.")
    }
    .sheet(isPresented: $askingPush) {
      PushAsk(audience: isSupplier ? .supplier : .guest) {
        askingPush = false
        Task { await PushRegistrar.shared.askIfNeeded() }
      }
    }
    // The page's purchase, paid without leaving the app. Its «Төлсөн, шалгах»
    // asks the page, which closes the sheet itself once the order is bought.
    .sheet(item: $paying) { request in
      QPaySheet(request: request, check: {
        page.askToCheck()
        return false
      }) {
        paying = nil
      }
    }
    // The supplier's counter is where new orders arrive, and push is how they
    // reach a supplier who is not looking: asked as it opens, not after an
    // order of their own they will never place.
    .onChange(of: page.loaded) { _, loaded in
      guard loaded, isSupplier else { return }
      Task { await offerPush() }
    }
    .onAppear {
      page.home = back
      page.signIn = { signingIn = true }
      page.pay = { paying = $0 }
      page.paid = { paying = nil }
      page.changed = {
        Task {
          await model.refreshLive()
          await offerPush()
        }
      }
      page.load(Endpoint.base, path: path, token: session.token)
    }
    .onChange(of: session.token) { _, token in
      page.deliver(token: token)
    }
    .task {
      try? await Task.sleep(for: .milliseconds(450))
      slow = true
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

  private var isSupplier: Bool { app == AppCatalogue.supplier.id }

  /// The moment the question is about something, if iOS has never put it: a
  /// guest's order running — just paid for, as a rule — or a supplier's
  /// counter open.
  private func offerPush() async {
    guard session.isSignedIn, !signingIn, !askingPush else { return }
    guard isSupplier || !(model.live.isEmpty && model.liveIdesh.isEmpty) else { return }
    guard await PushRegistrar.shared.shouldOffer() else { return }
    PushRegistrar.shared.markOffered()
    askingPush = true
  }
}

/**
 «‹ Basu»: the shell's way out of an app, drawn by the shell, in the page's
 own words for it. Shown until the page has drawn its own «‹ Basu» in the
 same corner, and whenever the page cannot be reached — it is the one control
 that does not depend on the page.
 */
private struct HomeChip: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Chevron(direction: .back, size: 17, lineWidth: 2)
        Text("Basu")
          .font(.sans(15, .bold))
      }
      .foregroundStyle(Color.ink)
      .padding(.leading, 12)
      .padding(.trailing, 16)
      .frame(minHeight: BasuMetric.minTarget)
      .glass(in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(Pressable())
    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    .padding(.leading, BasuMetric.screenPadding - 6)
    .accessibilityLabel("Basu нүүр")
    .accessibilityIdentifier("service.home")
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
  /// The page this app opened on has drawn — its own «‹ Basu» is there.
  private(set) var loaded = false
  /// The web view has history to go back through (`pushState` included).
  private(set) var canGoBack = false
  private var watching: NSKeyValueObservation?
  private weak var edge: UIScreenEdgePanGestureRecognizer?

  /// The page is up and has screens of its own to go back through, so the
  /// edge swipe is the page's until it is on its first one. A page that never
  /// drew has nothing to go back through, whatever its history says: a failed
  /// load leaves an entry behind, and the swipe must still leave the app.
  var walksItsOwnHistory: Bool { canGoBack && loaded && !unreachable }

  /// What the page's state decides in UIKit: who has the edge swipe, and
  /// whether VoiceOver may read the page at all — an unreachable one is a
  /// proxy's «502 Bad Gateway» or a blank, never something to read out.
  private func follow() {
    edge?.isEnabled = walksItsOwnHistory
    webView.isHidden = unreachable
  }

  var home: (() -> Void)?
  var signIn: (() -> Void)?
  var changed: (() -> Void)?
  /// The page's QPay invoice, for the shell's sheet; and the word that it is settled.
  var pay: ((PayRequest) -> Void)?
  var paid: (() -> Void)?

  private var base = Endpoint.base
  private var pending: URLRequest?
  /// The app's own pages: the path it was opened on, and what is under it.
  private var prefix = "/"
  /// The last answer for the whole page was the server failing — a proxy's
  /// error page is not the app having loaded.
  private var failedAnswer = false

  /// The page's side of the bridge: `window.webkit.messageHandlers.basu`.
  static let handler = "basu"

  let webView: WKWebView

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isOpaque = false
    webView.backgroundColor = .clear
    // What a rubber-band pull shows past the page's edge: the charcoal, not white.
    webView.underPageBackgroundColor = UIColor(rgb: 0x100D0C)
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    // WebKit's own swipe skips history a page added after waiting on the
    // network — idesh opens a stall that way — so on idesh it never went
    // anywhere. The edge is this file's instead (`edgeSwiped`).
    webView.allowsBackForwardNavigationGestures = false
    #if DEBUG
      // Safari → Develop → the simulator, for the page as it is here.
      webView.isInspectable = true
    #endif
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    configuration.userContentController.add(Relay(self), name: Self.handler)

    let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgeSwiped(_:)))
    edge.edges = .left
    edge.delegate = self
    edge.isEnabled = false
    webView.addGestureRecognizer(edge)
    self.edge = edge
    // `pushState` tells no navigation delegate anything; the history does.
    // With history the edge walks it; without, the stack's own swipe leaves.
    watching = webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] web, _ in
      MainActor.assumeIsolated {
        self?.canGoBack = web.canGoBack
        self?.follow()
      }
    }
  }

  /// A swipe from the left edge, while the page has screens of its own to go
  /// back through: the page's own `history.back()`, as a browser's back
  /// button would — the page draws its previous screen on `popstate`.
  @objc private func edgeSwiped(_ edge: UIScreenEdgePanGestureRecognizer) {
    guard edge.state == .ended else { return }
    let moved = edge.translation(in: webView).x
    let speed = edge.velocity(in: webView).x
    guard moved > 72 || speed > 600 else { return }
    webView.evaluateJavaScript("history.back()")
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
    // This shell pays in its own sheet (`pay` below): said before the page runs,
    // so it asks for QPay's QR and bank apps rather than a page to open.
    controller.addUserScript(WKUserScript(
      source: "window.__basuPays = true;",
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true,
    ))
    // And calls with the phone's own call screen (`call` below): the order page
    // offers «Апп-аар залгах» only to a shell that says so.
    controller.addUserScript(WKUserScript(
      source: "window.__basuCalls = true;",
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true,
    ))
    guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { return }
    prefix = url.path.isEmpty ? "/" : url.path
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    pending = request
    webView.load(request)
  }

  func reload() {
    unreachable = false
    loaded = false
    follow()
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
  /// The web launcher, which is where a page's «‹ Basu» goes in a browser:
  /// `/` until the front page took that address, `/app` since.
  private func isHome(_ url: URL) -> Bool {
    url.host == base.host && url.port == base.port && ["", "/", "/app", "/app/"].contains(url.path)
  }

  private func isOurs(_ url: URL) -> Bool {
    url.host == base.host && url.port == base.port
  }

  /**
   The pages this app may show inside the shell: its own (`/idesh` and what is
   under it), the other app a guest has (the lunch page with no restaurant
   points to the winter-meat one, and back), and the two every page links
   to. Anything else of ours — the dashboard, the website's sign-in — is the
   website, and opens in Safari: inside the app it was a page with no way
   back to it.
   */
  nonisolated static func belongs(_ path: String, to prefix: String) -> Bool {
    if ["/terms", "/privacy"].contains(path) { return true }
    let own = prefix.hasSuffix("/") && prefix.count > 1 ? String(prefix.dropLast()) : prefix
    let guests = ["/dine", "/idesh"]
    let mates = guests.contains(own) ? guests : [own]
    return mates.contains { path == $0 || path.hasPrefix($0 + "/") }
  }

  /// The kitchen's screen is for a kitchen's own tablet. A guest's app goes
  /// nowhere near it — not even to Safari.
  nonisolated static func staffOnly(_ path: String) -> Bool {
    path == "/kds" || path.hasPrefix("/kds/")
  }

  /// «Төлсөн, шалгах» in the shell's sheet: the page asks, as its own button would.
  func askToCheck() {
    webView.evaluateJavaScript("if (typeof window.__basuCheckPay === 'function') window.__basuCheckPay();")
  }

  // MARK: the page's messages

  fileprivate func received(_ body: Any) {
    guard let message = body as? [String: Any], let type = message["type"] as? String else { return }
    switch type {
    case "signIn": signIn?()
    case "orders": changed?()
    case "home": home?()
    case "pay":
      if let request = Self.payRequest(message["invoice"]) { pay?(request) }
    case "paid": paid?()
    case "call":
      guard let subject = message["subject"] as? String, let subjectId = message["subject_id"] as? String else { return }
      CallCenter.shared.ringOut(subject: subject, subjectId: subjectId, peerName: message["peer_name"] as? String ?? "")
    default: break
    }
  }

  /// `{ amount_mnt, qpay: { qr, banks, expires_at } }`, as the page has it from the server.
  private static func payRequest(_ value: Any?) -> PayRequest? {
    guard let value, JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    struct Handed: Decodable {
      let amountMnt: Int
      let qpay: QPayInvoice
      enum CodingKeys: String, CodingKey {
        case qpay
        case amountMnt = "amount_mnt"
      }
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      guard let date = ISODate.parse(text) else {
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a date: \(text)"))
      }
      return date
    }
    guard let handed = try? decoder.decode(Handed.self, from: data) else { return nil }
    return PayRequest(id: handed.qpay.qr, amountMnt: handed.amountMnt, invoice: handed.qpay)
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

    // A phone number, an SMS — anything that is not a page — is the
    // system's. A web view given `tel:` to load fails it quietly, and the
    // supplier's number on an order is the one link a guest most needs.
    if let scheme = url.scheme, !["http", "https", "about", "blob", "data", "file"].contains(scheme) {
      await UIApplication.shared.open(url)
      return .cancel
    }

    // A link out of the page — the tile attribution, a restaurant's site —
    // is Safari's, not this screen's. So is anything asking for a new window,
    // and so is any page of ours that is not this app's.
    let web = ["http", "https"].contains(url.scheme ?? "")
    if web, isOurs(url), Self.staffOnly(url.path) { return .cancel }
    let external = web && !isOurs(url)
    let elsewhere = web && isOurs(url) && action.targetFrame?.isMainFrame == true
      && !Self.belongs(url.path, to: prefix)
    if external || elsewhere || action.targetFrame == nil {
      await UIApplication.shared.open(url)
      return .cancel
    }
    return .allow
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor response: WKNavigationResponse,
  ) async -> WKNavigationResponsePolicy {
    if response.isForMainFrame {
      failedAnswer = ((response.response as? HTTPURLResponse)?.statusCode ?? 200) >= 500
      // A proxy's «502 Bad Gateway» is never drawn, nor read out: the load
      // fails here, and the shell says the server is not answering.
      if failedAnswer { return .cancel }
    }
    return .allow
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // A refused connection does not always arrive as a failure. On iOS 26 the
    // web view answers it by finishing `about:blank` instead, with no error
    // callback at all — so "the page that finished is not the one asked for"
    // is the outage, and is the only signal there reliably is.
    if let url = webView.url, isOurs(url), !failedAnswer {
      unreachable = false
      loaded = true
    } else {
      unreachable = true
    }
    follow()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // A cancelled load is this file's own doing (see above), not an outage —
    // unless what was cancelled was the server's error page.
    if (error as NSError).code == NSURLErrorCancelled, !failedAnswer { return }
    unreachable = true
    follow()
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code == NSURLErrorCancelled { return }
    unreachable = true
    follow()
  }
}

extension ServicePage: UIGestureRecognizerDelegate {
  /// The edge swipe and the page's own scrolling both see the touch; a swipe
  /// that starts at the edge is rarely a scroll, and never only one.
  func gestureRecognizer(
    _ recognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer,
  ) -> Bool {
    true
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
