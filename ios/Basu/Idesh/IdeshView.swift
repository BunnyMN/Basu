import SwiftUI
import WebKit

/**
 Өвлийн идэш — the web page, inside the app.

 The vertical is built once, as a page this server serves, and shown here in
 a WKWebView rather than rewritten in SwiftUI. Not a shortcut in disguise:
 the page is Basu's own, on Basu's own server, and the decision and its
 trade-offs are written down in docs/adr/0001. What stays native is the
 frame — the way back, the sign-in, and what to say when the server cannot
 be reached — because those are the shell's, and a blank webview says none
 of it.

 The guest's token is handed to the page before it loads, into the same
 `localStorage` key the web client reads. In Safari the page would have
 minted one itself; here the person is already signed in and should not be
 asked twice.
 */
struct IdeshView: View {
  /// Set when the home screen sent somebody straight to an order they have.
  let resuming: String?

  @Environment(AppModel.self) private var app
  @Environment(Session.self) private var session
  @Environment(\.dismiss) private var dismiss

  @State private var trouble: String?
  @State private var attempt = 0
  @State private var signingIn = false

  private var url: URL {
    var components = URLComponents(
      url: app.api.base.appendingPathComponent("idesh"),
      resolvingAgainstBaseURL: false,
    )!
    if let resuming { components.queryItems = [URLQueryItem(name: "order", value: resuming)] }
    return components.url!
  }

  var body: some View {
    ZStack(alignment: .top) {
      Color.bg.ignoresSafeArea()

      if session.isSignedIn {
        WebPage(
          url: url,
          token: session.token,
          attempt: attempt,
          onFail: { trouble = $0 },
          onHome: { dismiss() },
        )
        .ignoresSafeArea(edges: .bottom)
        .accessibilityIdentifier("idesh.web")
      } else {
        signIn
      }

      if trouble != nil {
        // The same words the launcher uses for the same problem.
        OfflineBanner {
          trouble = nil
          attempt += 1
        }
        .padding(12)
      }
    }
    .navigationTitle("Идэш")
    .navigationBarTitleDisplayMode(.inline)
    // The way back says where it goes, as it does in the dine app.
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button { dismiss() } label: {
          HStack(spacing: 2) {
            Image(systemName: "chevron.left")
            Text("Basu").font(.system(size: 15, weight: .semibold))
          }
        }
        .accessibilityIdentifier("idesh.home")
      }
    }
    .sheet(isPresented: $signingIn) { SignInSheet() }
    // Whatever was bought in there belongs on the launcher the moment the
    // person comes back out.
    .onDisappear { Task { await app.refreshLive() } }
  }

  /// A stranger gets the stalls in Safari. In the app the launcher is one tap
  /// away and knows who you are, so the page is not opened until it can too.
  private var signIn: some View {
    VStack(spacing: 14) {
      Text("Идэш захиалахын тулд нэвтэрнэ үү")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(Color.ink)
      Text("Утасны дугаар, нэг удаагийн код. Нууц үг байхгүй.")
        .font(.system(size: 14))
        .foregroundStyle(Color.ink2)
        .multilineTextAlignment(.center)
      WideButton(title: "Нэвтрэх") { signingIn = true }
        .accessibilityIdentifier("idesh.signin")
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/**
 The web view itself. Created once and left alone: SwiftUI calls
 `updateUIView` on every state change, and reloading a page somebody is
 typing an address into would be the whole app's worst moment.
 */
private struct WebPage: UIViewRepresentable {
  let url: URL
  let token: String?
  /// Bumped to ask for a reload after a failure.
  let attempt: Int
  let onFail: (String) -> Void
  let onHome: () -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(onFail: onFail, onHome: onHome, base: url)
  }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    if let token, let json = try? JSONEncoder().encode(token), let literal = String(data: json, encoding: .utf8) {
      // Before any script on the page runs, and only on our own frame.
      let script = WKUserScript(
        source: "try { localStorage.setItem('basu.guest', \(literal)); } catch (e) {}",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true,
      )
      configuration.userContentController.addUserScript(script)
    }

    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.contentInsetAdjustmentBehavior = .never
    view.load(URLRequest(url: url))
    context.coordinator.attempt = attempt
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    guard context.coordinator.attempt != attempt else { return }
    context.coordinator.attempt = attempt
    view.load(URLRequest(url: url))
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate {
    let onFail: (String) -> Void
    let onHome: () -> Void
    let base: URL
    var attempt = 0

    init(onFail: @escaping (String) -> Void, onHome: @escaping () -> Void, base: URL) {
      self.onFail = onFail
      self.onHome = onHome
      self.base = base
    }

    /// The page's own «‹ Basu» goes to `/`, the web launcher. In the app the
    /// launcher is the screen underneath, so that link closes this one instead.
    func webView(
      _ webView: WKWebView,
      decidePolicyFor action: WKNavigationAction,
      decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void,
    ) {
      guard let target = action.request.url else { return decisionHandler(.allow) }

      if target.scheme == "tel" {
        // Calling the supplier is the phone's job, not the page's.
        UIApplication.shared.open(target)
        return decisionHandler(.cancel)
      }
      if action.navigationType == .linkActivated, target.host == base.host, target.path == "/" {
        onHome()
        return decisionHandler(.cancel)
      }
      decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
      onFail(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
      // A cancelled navigation is the user tapping something else, not a failure.
      if (error as NSError).code == NSURLErrorCancelled { return }
      onFail(error.localizedDescription)
    }
  }
}
