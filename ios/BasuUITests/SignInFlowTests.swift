import XCTest

/**
 The way in, the way a person takes it.

 Signed out, the app is the way in and nothing else: no launcher behind it,
 no tab bar over it. Signed in, the gate is gone and the bell is up.

 By email: an address nobody has used asks for a code, reads it off the
 inbox, and is in — the six digits go without another tap. Apple's button is
 on the same sheet, as the App Store asks.

 With a password: a new address signs up — the code from the letter proves
 it, and six digits make the account without another tap — signs out, and
 comes back with the same password, typed beside the address. A wrong one is
 told so, with the way to sign up offered beside it. A server with no email
 signs up by number instead, as it did before there was email, and the test
 follows whichever the sheet draws.

 The password is in Cyrillic on purpose. A secure field on iOS offers only
 keyboards that type Latin, so a password chosen on the web in Mongolian can
 only be typed here with the field shown — which is what this checks.

 Runs against the developer's server on localhost and skips when nothing is
 listening, like the other flows. Every run uses an address or a number
 nobody has used, so it never trips over an account from an earlier run.
 */
@MainActor
final class SignInFlowTests: XCTestCase {
  private let base = URL(string: ProcessInfo.processInfo.environment["BASU_API"] ?? "http://localhost:3000")!

  private struct Stop: Error {}

  /// An async test carries on past a failed assertion; this one should not.
  private func check(_ ok: Bool, _ message: String) throws {
    XCTAssertTrue(ok, message)
    guard !ok else { return }
    shot("failed-here")
    let tree = XCTAttachment(string: XCUIApplication().debugDescription)
    tree.name = "tree"
    tree.lifetime = .keepAlways
    add(tree)
    throw Stop()
  }

  private func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testANewAddressAsksForACodeAndIsIn() async throws {
    let api = DemoAPI(base: base)
    try await api.requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()
    try signOutIfSignedIn(app)

    try check(app.buttons["signin.apple"].waitForExistence(timeout: 5), "Apple's button is on the first face of the way in")
    try check(!app.buttons["tab.home"].exists, "and there is no tab bar under it")
    let field = app.textFields["signin.email"]
    guard field.waitForExistence(timeout: 5) else {
      throw XCTSkip("The server on \(base) has no email door.")
    }
    shot("1-doors")

    let address = "ui\(Int.random(in: 100_000..<999_999))@example.mn"
    try type(field, address)
    app.buttons["signin.emailGo"].tap()
    let codeField = app.textFields["signin.emailCode"]
    try check(codeField.waitForExistence(timeout: 10), "a code went out, and the sheet asks for it")
    shot("2-code-sent")

    let code = try await api.emailCode(to: address)
    codeField.typeText(code)
    try check(app.buttons["home.inbox"].waitForExistence(timeout: 10), "six digits, and the person is in")
    shot("3-in")

    // The profile says who they are: the address, not a number.
    app.buttons["tab.profile"].tap()
    try check(app.staticTexts[address].waitForExistence(timeout: 10), "the profile shows the address")
    shot("4-profile")
    try signOutIfSignedIn(app)
  }

  func testANewAccountSignsUpWithAPasswordSignsOutAndComesBack() async throws {
    let api = DemoAPI(base: base)
    try await api.requireServer()

    let app = XCUIApplication()
    app.launchEnvironment["BASU_API"] = base.absoluteString
    app.launch()
    try signOutIfSignedIn(app)

    let password = "Хонь \(Int.random(in: 1000..<9999)) идэш"
    let login: String

    // ── sign up, in Cyrillic, with the field shown ────────────────────
    try openThePasswordDoor(app)
    let signUp = app.buttons["signin.door.signUp"]
    try check(signUp.waitForExistence(timeout: 5), "the password face should open on its two doors")
    signUp.tap()
    app.buttons["signin.reveal"].tap()
    if app.textFields["signin.name"].waitForExistence(timeout: 3) {
      // By email: a name, the address, the password twice — then the code.
      login = "ui\(Int.random(in: 100_000..<999_999))@example.mn"
      try type(app.textFields["signin.name"], "Бат")
      try type(app.textFields["signin.login"], login)
      try type(app.textFields["signin.password"], password)
      try type(app.textFields["signin.again"], password)
      shot("1-sign-up")
      app.buttons["signin.go"].tap()
      let codeField = app.textFields["signin.signUpCode"]
      try check(codeField.waitForExistence(timeout: 10), "a code went to the address, and the sheet asks for it")
      let code = try await api.emailCode(to: login)
      codeField.tap()
      codeField.typeText(code)
    } else {
      // No email on this server: a number and a password, as before.
      login = "88" + String(format: "%06d", Int.random(in: 0..<1_000_000))
      try type(app.textFields["signin.phone"], login)
      try type(app.textFields["signin.password"], password)
      try type(app.textFields["signin.again"], password)
      shot("1-sign-up")
      app.buttons["signin.go"].tap()
    }
    try check(app.buttons["home.inbox"].waitForExistence(timeout: 10), "signed up, the launcher replaces the way in")
    declineSavingThePassword(app)

    // ── out, and a wrong password ─────────────────────────────────────
    try signOutIfSignedIn(app)
    try openThePasswordDoor(app)
    try type(app.textFields["signin.login"], login)
    try type(app.secureTextFields["signin.password"], "wrong-password-1")
    app.buttons["signin.go"].tap()
    try check(app.staticTexts["signin.trouble"].waitForExistence(timeout: 10), "a wrong password is said out loud")
    try check(app.buttons["signin.offerSignUp"].exists, "and the way to sign up is offered beside it")
    shot("2-wrong-password")

    // ── back in, with the right one ───────────────────────────────────
    // Shown, while the keyboard is still up: the field keeps it, and the
    // keyboard's own «go» is the way to send, as a thumb would.
    app.buttons["signin.reveal"].tap()
    try replace(app.textFields["signin.password"], with: password + "\n")
    try check(app.buttons["home.inbox"].waitForExistence(timeout: 10), "the same password opens the same account")
    declineSavingThePassword(app)
    shot("3-back-in")

    // Out again: the keychain outlives the run, and the next suite expects
    // the demo guest or nobody, not this stranger.
    try signOutIfSignedIn(app)
  }

  /// iOS offers to keep a password it has just seen work, over the launcher.
  /// Not now: a test's simulator has nothing to fill it into.
  private func declineSavingThePassword(_ app: XCUIApplication) {
    let notNow = app.buttons["Not Now"]
    if notNow.waitForExistence(timeout: 3) { notNow.tap() }
  }

  /// The password is one tap past the first face of the way in — unless the
  /// server has no other door, and it opens on the password. The link sits
  /// under the email door, perhaps below the fold.
  private func openThePasswordDoor(_ app: XCUIApplication) throws {
    let way = app.buttons["signin.passwordWay"]
    if !way.waitForExistence(timeout: 3), !app.buttons["signin.door.signIn"].exists { app.swipeUp() }
    if way.waitForExistence(timeout: 5) { way.tap() }
    try check(app.buttons["signin.door.signIn"].waitForExistence(timeout: 5), "the password door should be open")
  }

  private func type(_ element: XCUIElement, _ text: String) throws {
    try check(element.waitForExistence(timeout: 5), "\(element) should be on the sheet")
    element.tap()
    element.typeText(text)
  }

  private func replace(_ element: XCUIElement, with text: String) throws {
    try check(element.waitForExistence(timeout: 5), "\(element) should be on the sheet")
    // The field was just swapped from hidden to shown; let the swap settle.
    let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: element)
    _ = XCTWaiter.wait(for: [settled], timeout: 3)
    element.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    let old = (element.value as? String) ?? ""
    element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
    element.typeText(text)
  }

  /// Signed in from an earlier run: out through the profile, the one place
  /// that says «Гарах» — and the way in takes the whole screen again.
  private func signOutIfSignedIn(_ app: XCUIApplication) throws {
    guard app.landing() == .shell else { return }
    app.buttons["tab.profile"].tap()
    let out = app.buttons["profile.signout"]
    if !out.waitForExistence(timeout: 5) { app.swipeUp() }
    out.tap()
    try check(app.buttons["signin.apple"].waitForExistence(timeout: 10), "signed out, the way in is back")
    try check(!app.buttons["tab.home"].exists, "…and the tab bar is gone with the launcher")
  }
}
