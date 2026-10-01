import SwiftUI
import UIKit

/**
 The navigation stack's own edge swipe, on a screen that hides the bar.

 UIKit turns the swipe off with the bar: it stands in for the bar's back
 button, and with no bar UIKit assumes there is nothing to go back to. Every
 screen the shell pushes hides the bar and draws its own way back, so the
 swipe went with it — and an app page that did not load had no way back at
 all but force-quitting.

 This puts the swipe back while the screen is up. `enabled` hands the edge
 to something else for a while: a page with history of its own (idesh's
 stall → review → status) has the web view's swipe, which walks that history,
 and the stack's swipe stays out of its way until the page is back on its
 first screen. Turned off rather than refused: a refusal still took the
 touch, and the page's swipe never began.
 */
struct InteractivePop: UIViewControllerRepresentable {
  /// Whether a swipe from the edge leaves the screen now.
  var enabled = true

  func makeUIViewController(context: Context) -> Anchor { Anchor() }

  func updateUIViewController(_ anchor: Anchor, context: Context) {
    anchor.enabled = enabled
  }

  /// An invisible child of the screen, there to find the stack it was pushed
  /// onto and to answer for the swipe while the screen is showing.
  final class Anchor: UIViewController, UIGestureRecognizerDelegate {
    var enabled = true {
      didSet { claimed?.isEnabled = enabled }
    }
    private weak var claimed: UIGestureRecognizer?
    private weak var previous: (any UIGestureRecognizerDelegate)?

    override func viewDidLoad() {
      super.viewDidLoad()
      view.isUserInteractionEnabled = false
      view.backgroundColor = .clear
    }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      guard let pop = navigationController?.interactivePopGestureRecognizer else { return }
      if pop.delegate !== self {
        previous = pop.delegate
        pop.delegate = self
      }
      pop.isEnabled = enabled
      claimed = pop
    }

    override func viewWillDisappear(_ animated: Bool) {
      super.viewWillDisappear(animated)
      // Handed back as the screen starts to go: the next screen down keeps
      // UIKit's own rules.
      if let claimed {
        if claimed.delegate === self { claimed.delegate = previous }
        claimed.isEnabled = true
      }
      claimed = nil
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
      // Never from the root: popping nothing freezes the stack.
      guard let stack = navigationController else { return false }
      return enabled && stack.viewControllers.count > 1
    }
  }
}
