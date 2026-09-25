import AuthenticationServices
import BasuKit
import CryptoKit
import SwiftUI

/**
 Signing in.

 Apple and Google first: one tap each for most people. Then a code by email,
 which needs nothing but an inbox — the address becomes the account the
 first time a code sent to it comes back. A password is one tap further:
 signing in with an address or a phone number, signing up with an address,
 and getting a forgotten password back — the last two by a code to the
 inbox, because there is no SMS, and a password nobody can reset is a door
 that locks for good. There are no invitation codes: whoever is given a role
 signs in the same way as everybody, and the role finds them.

 Only the doors the server has open are drawn. Apple is always there — the
 App Store asks for it beside any other social sign-in — and a server that
 has neither Google nor email set up leaves Apple and the password, whose
 sign-up then falls back to a phone number and whose forgotten password
 has nowhere to be sent.

 Google runs in the system's own sign-in sheet, never a web view of ours:
 Google refuses an embedded view, and it is right to. The server sends the
 person to Google and back to `basu://auth`, and the system sheet hands that
 address straight back to this screen — a link to it opened from anywhere
 else is ignored (see `BasuApp.open`).

 The same doors are two things. Signed out, they are the whole app: `RootView`
 draws them in place of the shell, with no tab bar and nothing to close, and
 swaps them for the launcher the moment a session exists (`gate`). Signed in,
 a page inside the app that needs a guest can still ask for them as a sheet.

 A debug build pointed at a developer's own server has one more button, which
 goes straight to a session the way that server allows. It is compiled out of
 anything shipped, and hidden against the pilot, which has no such door.
 */
struct SignInSheet: View {
  /// The whole screen of a signed-out app rather than a sheet over something:
  /// the wordmark on top, nothing to close, nothing to dismiss once in.
  var gate = false

  /// Which face the sheet shows: the doors most people take, or the password.
  enum Way: Hashable { case doors, password }
  enum Door: Hashable { case signIn, signUp, forgot }
  /// Each password has two fields, one hidden and one shown — see `PasswordField`.
  fileprivate enum Field: Hashable {
    case email, emailCode, name, login, letterCode, phone, password, passwordShown, again, againShown
  }

  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model
  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession

  @State private var way: Way = .doors
  /// Whether the sheet opened on somebody already signed in. A sign-in made
  /// here does not turn the sheet into the account view: it closes with the
  /// doors still on it.
  @State private var arrivedSignedIn: Bool?
  /// Asked of the server when the sheet opens; nil until it answers.
  @State private var methods: AuthMethods?
  @State private var busy = false
  @State private var trouble: String?

  // a code by email
  @State private var email = ""
  @State private var emailCode = ""
  /// The address the last code went to. Typing another starts over.
  @State private var codeSentTo: String?

  // Apple
  /// The nonce whose hash went to Apple with the request; the server checks
  /// the token carries it.
  @State private var appleNonce = ""

  // a password
  @State private var door: Door = .signIn
  /// An address or a number: signing in, signing up by email, forgetting.
  @State private var login = ""
  @State private var name = ""
  /// A sign-up's number, when the server has no email.
  @State private var phone = ""
  @State private var password = ""
  @State private var again = ""
  /// The six digits from the letter that lets a password be chosen.
  @State private var letterCode = ""
  /// Where that letter went, as the server says it — masked when a number
  /// was typed. Nil until one has gone.
  @State private var letterSentTo: String?
  /// The login it went for. Typing another starts over.
  @State private var letterFor: String?
  /// Typed in the open. A secure field on iOS offers only keyboards that type
  /// Latin, and a password chosen on the web may be in Cyrillic — shown, the
  /// field takes the Mongolian keyboard like any other.
  @State private var reveal = false
  /// The refusal was "wrong number or password" — which is also what a new number hears.
  @State private var offerSignUp = false
  @FocusState private var focus: Field?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 0) {
          if gate { hero } else if !showsAccount { sheetHead }
          if gate && model.offline {
            OfflineBanner {
              await model.retry()
              if !model.offline { methods = await session.methods() }
            }
            .padding(.top, 18)
          }
          Group {
            if showsAccount {
              account
            } else if way == .password {
              passwordDoors
            } else {
              doors
            }
          }
          .padding(.top, 18)
          if !showsAccount { legal }
          developerDoor
        }
        .padding(.horizontal, BasuMetric.screenPadding)
        .padding(.bottom, 28)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity)
        .animation(.snappy(duration: 0.28), value: way)
        .animation(.snappy(duration: 0.28), value: door)
        .animation(.snappy(duration: 0.28), value: codeSentTo)
        .animation(.snappy(duration: 0.28), value: letterFor)
        .animation(.easeOut(duration: 0.2), value: trouble)
        .animation(.snappy(duration: 0.3), value: focus)
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)
      // The navigation container's own ground, not the scroll view's: under
      // a keyboard on its way down there is otherwise a band of plain white.
      .containerBackground(for: .navigation) { Backdrop().ignoresSafeArea() }
      .navigationTitle(gate || !showsAccount ? "" : title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if !gate {
          ToolbarItem(placement: .topBarLeading) {
            Button("Хаах") { dismiss() }
          }
        }
      }
      .toolbarVisibility(gate ? .hidden : .automatic, for: .navigationBar)
    }
    .presentationDetents([.large])
    .onAppear {
      if arrivedSignedIn == nil { arrivedSignedIn = session.isSignedIn }
    }
    .task {
      guard methods == nil else { return }
      let open = await session.methods()
      methods = open
      // A server with no door but the password: the password is the sheet.
      if !open.apple && !open.google && !open.email { way = .password }
    }
  }

  // MARK: - the head

  /**
   The gate's head: a photograph of what Basu is for, the wordmark on it in
   white, and one line that says it — the web's front page in miniature.
   Past the first face, and while anything is typed, the picture folds to a
   band so the fields and the keyboard both fit, and the line becomes the
   door that is open.

   The buuz are Tuguldur Baatar's, from Unsplash (free for commercial use;
   credited with the web's photographs in src/web/brand/meat/CREDITS.txt).
   */
  private var hero: some View {
    let first = way == .doors
    let small = !first || focus != nil
    let shape = RoundedRectangle(cornerRadius: BasuMetric.authCard, style: .continuous)
    return ZStack(alignment: .bottomLeading) {
      Image("SignInPhoto")
        .resizable()
        .scaledToFill()
        .frame(height: small ? BasuMetric.authPhoto * 0.55 : BasuMetric.authPhoto)
        .frame(maxWidth: .infinity)
        .clipped()
        .accessibilityHidden(true)
      // A shade for the words, from nothing at the middle to most of black
      // at the foot: white type on a photograph needs somewhere to stand.
      LinearGradient(
        colors: [Color.black.opacity(0), Color.black.opacity(0.72)],
        startPoint: UnitPoint(x: 0.5, y: 0.3),
        endPoint: .bottom,
      )
      VStack(alignment: .leading, spacing: 4) {
        Text("Basu")
          .font(.sans(small ? 28 : 36, .semibold))
          .tracking(-0.03 * (small ? 28 : 36))
        Text(first ? "Хоолоо урьдчилан захиалж, өвлийн идшээ гэрээт малчнаас ав." : title)
          .font(.sans(first ? 14 : 16, first ? .regular : .medium))
          .opacity(0.86)
          .fixedSize(horizontal: false, vertical: true)
          .contentTransition(.opacity)
      }
      .foregroundStyle(.white)
      .padding(18)
    }
    .clipShape(shape)
    .overlay(shape.strokeBorder(Color.line, lineWidth: BasuMetric.hairline))
    .padding(.top, 8)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Basu · \(title)")
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("signin.gate")
  }

  /// A sheet over a page: no photograph, the title large and on the ground.
  private var sheetHead: some View {
    Text(title)
      .font(.sans(28, .semibold))
      .tracking(-0.02 * 28)
      .foregroundStyle(Color.ink)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 4)
      .accessibilityAddTraits(.isHeader)
  }

  /// The two pages every way in is under, one tap from the door.
  private var legal: some View {
    HStack(spacing: 6) {
      Link("Үйлчилгээний нөхцөл", destination: Endpoint.base.appending(path: "terms"))
      Text("·").foregroundStyle(Color.ink3)
      Link("Нууцлалын бодлого", destination: Endpoint.base.appending(path: "privacy"))
    }
    .font(.sans(12.5))
    .tint(Color.ink2)
    .padding(.top, 26)
  }

  // MARK: - signed in

  private var showsAccount: Bool { (arrivedSignedIn ?? session.isSignedIn) && session.isSignedIn }

  private var account: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        if let phone = platform.me?.phone ?? session.phone {
          Text("Утас").font(.sans(13)).foregroundStyle(Color.ink3)
          Text(phone).font(.mono(16)).foregroundStyle(Color.ink)
        } else if let email = platform.me?.email ?? session.email {
          Text("Имэйл").font(.sans(13)).foregroundStyle(Color.ink3)
          Text(email).font(.sans(16)).foregroundStyle(Color.ink)
        }
      }
      WideButton(title: "Гарах", kind: .danger) {
        session.signOut()
        Task { await model.refreshLive() }
        dismiss()
      }
      Text("Гарсан ч захиалга чинь хэвээр. Дахин нэвтэрвэл гарч ирнэ.")
        .font(.sans(12.5))
        .foregroundStyle(Color.ink3)
    }
    .padding(20)
    .authCard()
  }

  // MARK: - the doors

  private var doors: some View {
    VStack(spacing: 16) {
      VStack(spacing: 12) {
        SignInWithAppleButton(.signIn) { request in
          let nonce = Nonce.make()
          appleNonce = nonce
          request.requestedScopes = [.fullName, .email]
          request.nonce = Nonce.sha256(nonce)
        } onCompletion: { result in
          Task { await signInWithApple(result) }
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: BasuMetric.controlHeight)
        .clipShape(RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
        .accessibilityIdentifier("signin.apple")

        if methods?.google == true {
          GoogleButton { Task { await signInWithGoogle() } }
            .accessibilityIdentifier("signin.google")
        }

        if methods?.email == true {
          OrLine(words: "эсвэл имэйлээр")
            .padding(.vertical, 4)
          emailDoor
        }

        troubleView
      }
      .disabled(busy && codeSentTo == nil)
      .padding(18)
      .authCard()

      WayButton(
        title: "Нууц үгээр нэвтрэх, бүртгүүлэх",
        detail: "Имэйл эсвэл утасны дугаар, нууц үгээр. Нууц үгээ мартсан бол мөн эндээс.",
        symbol: "key",
      ) { switchTo(.password) }
        .accessibilityIdentifier("signin.passwordWay")
    }
  }

  @ViewBuilder private var emailDoor: some View {
    AuthField(symbol: "envelope", active: focus == .email) { focus = .email } content: {
      TextField("Имэйл хаяг", text: $email)
        .keyboardType(.emailAddress)
        .textContentType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($focus, equals: .email)
        .submitLabel(.send)
        .onSubmit { Task { await askForCode() } }
        .onChange(of: email) { _, typed in
          // Another address after a code went out is a new start, not a
          // code for the old one.
          if let sent = codeSentTo, Session.address(typed) != sent { startOver() }
        }
        .accessibilityIdentifier("signin.email")
    }

    if codeSentTo != nil {
      CodeInput(code: $emailCode, focus: $focus, field: .emailCode, id: "signin.emailCode")
        .onChange(of: emailCode) { _, typed in
          let digits = String(typed.filter(\.isNumber).prefix(6))
          if digits != typed { emailCode = digits }
          // Six digits is the whole code: pasted or typed, it goes
          // without another tap.
          if digits.count == 6 { Task { await checkEmailCode() } }
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    Note(text: emailFooter)

    PrimaryButton(title: codeSentTo == nil ? "Код авах" : "Нэвтрэх", enabled: emailReady, busy: busy) {
      Task { if codeSentTo == nil { await askForCode() } else { await checkEmailCode() } }
    }
    .accessibilityIdentifier("signin.emailGo")

    if codeSentTo != nil {
      HStack {
        Button("Код дахин авах") { Task { await askForCode() } }
          .accessibilityIdentifier("signin.resend")
        Spacer()
        Button("Хаяг солих") {
          startOver()
          focus = .email
        }
      }
      .font(.sans(14, .medium))
      .tint(Color.accent)
    }
  }

  private var emailFooter: String {
    if let sent = codeSentTo {
      return "\(sent) хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
    }
    return "Хаяг руу тань 6 оронтой код илгээнэ. Анх удаа бол бүртгэл шууд үүснэ."
  }

  private var emailReady: Bool {
    guard !busy else { return false }
    if codeSentTo == nil { return Session.address(email).contains("@") }
    return emailCode.count == 6
  }

  private func startOver() {
    codeSentTo = nil
    emailCode = ""
  }

  // MARK: - a password

  /// Whether signing up, and a forgotten password, go by a code to an inbox.
  /// Without email the server can send neither: a sign-up is a number and a
  /// password, as it was before there was email, and there is no reset.
  private var byEmail: Bool { methods?.email == true }

  /// A sign-up or a reset whose letter has gone, waiting for its code.
  private var lettered: Bool { letterFor != nil }

  private var passwordDoors: some View {
    VStack(spacing: 16) {
      if door == .signIn || door == .signUp {
        DoorSwitch(door: Binding(get: { door }, set: { open($0) }))
      }

      VStack(spacing: 12) {
        if door == .signUp && !byEmail {
          phoneField
        } else {
          if door == .signUp { nameField }
          loginField
          if lettered { letterCodeField }
        }
        // A reset's new password is asked for once the code is on its way —
        // before that there is nothing to set it with.
        if door != .forgot || lettered { passwordFields }

        Note(text: footer)
        troubleView

        PrimaryButton(title: action, enabled: ready, busy: busy) {
          Task { await go() }
        }
        .accessibilityIdentifier("signin.go")

        if door == .signIn && byEmail {
          Button("Нууц үгээ мартсан?") { open(.forgot) }
            .font(.sans(14, .medium))
            .tint(Color.accent)
            .accessibilityIdentifier("signin.forgot")
        } else if lettered {
          Button("Код дахин авах") { Task { await askForLetter() } }
            .font(.sans(14, .medium))
            .tint(Color.accent)
            .accessibilityIdentifier("signin.resendLetter")
        }
      }
      .padding(18)
      .authCard()

      VStack(spacing: 10) {
        if door == .forgot {
          WayButton(title: "Нэвтрэх рүү буцах", symbol: "arrow.uturn.backward") { open(.signIn) }
            .accessibilityIdentifier("signin.back")
        }
        if methods.map({ $0.apple || $0.google || $0.email }) ?? false {
          WayButton(title: "Apple, Google эсвэл имэйлээр нэвтрэх", symbol: "apple.logo") { switchTo(.doors) }
            .accessibilityIdentifier("signin.doorsWay")
        }
      }
    }
  }

  private var nameField: some View {
    AuthField(symbol: "person", active: focus == .name) { focus = .name } content: {
      TextField("Нэр", text: $name)
        .textContentType(.name)
        .focused($focus, equals: .name)
        .submitLabel(.next)
        .onSubmit { focus = .login }
        .accessibilityIdentifier("signin.name")
    }
  }

  /**
   An address or a number, in one field. Which it is, is whether it has an @
   in it — the server tells them apart the same way. Signing up by email it
   is an address only.

   A username to iOS, so a saved password is offered for it and a new one is
   kept under it; the email keyboard, because the @ and the dot are the hard
   part to reach and digits are one key away.
   */
  private var loginField: some View {
    AuthField(symbol: door == .signUp ? "envelope" : "at", active: focus == .login) { focus = .login } content: {
      TextField(door == .signUp ? "Имэйл хаяг" : "Имэйл эсвэл утас", text: $login)
        .keyboardType(.emailAddress)
        .textContentType(.username)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($focus, equals: .login)
        .submitLabel(door == .forgot && !lettered ? .send : .next)
        .onSubmit {
          if door == .forgot {
            if lettered { focus = .letterCode } else { Task { await go() } }
          } else {
            focus = reveal ? .passwordShown : .password
          }
        }
        .onChange(of: login) { _, typed in
          // Another login after a code went out is a new start, not a code
          // for the old one.
          if let sent = letterFor, Session.login(typed) != sent { startLetterOver() }
        }
        .accessibilityIdentifier("signin.login")
    }
  }

  private var phoneField: some View {
    AuthField(symbol: "phone", active: focus == .phone) { focus = .phone } content: {
      TextField("Утасны дугаар · 8811 2233", text: $phone)
        .keyboardType(.phonePad)
        .textContentType(.telephoneNumber)
        .font(.mono(16))
        .focused($focus, equals: .phone)
        .accessibilityIdentifier("signin.phone")
    }
  }

  private var letterCodeField: some View {
    CodeInput(
      code: $letterCode,
      focus: $focus,
      field: .letterCode,
      id: door == .forgot ? "signin.resetCode" : "signin.signUpCode",
    )
    .onChange(of: letterCode) { _, typed in
      let digits = String(typed.filter(\.isNumber).prefix(6))
      if digits != typed {
        letterCode = digits
        return
      }
      guard digits.count == 6 else { return }
      // Six digits is the whole code. With the passwords already there it
      // goes without another tap; without, the keyboard moves on to them.
      if password.isEmpty {
        focus = reveal ? .passwordShown : .password
      } else if again.isEmpty {
        focus = reveal ? .againShown : .again
      } else {
        Task { await go() }
      }
    }
    .transition(.move(edge: .top).combined(with: .opacity))
  }

  @ViewBuilder private var passwordFields: some View {
    let first = focus == .password || focus == .passwordShown
    AuthField(symbol: "lock", active: first) { focus = reveal ? .passwordShown : .password } content: {
      HStack(spacing: 8) {
        PasswordField(
          title: door == .signIn ? "Нууц үг" : "Шинэ нууц үг · 8+ тэмдэгт",
          text: $password,
          reveal: reveal,
          content: door == .signIn ? .password : .newPassword,
          focus: $focus,
          hidden: .password,
          shown: .passwordShown,
        )
        .submitLabel(door == .signIn ? .go : .next)
        .onSubmit {
          if door == .signIn { Task { await go() } } else { focus = reveal ? .againShown : .again }
        }
        .accessibilityIdentifier("signin.password")
        RevealButton(reveal: $reveal, focus: $focus, twins: [(.password, .passwordShown), (.again, .againShown)])
          .accessibilityIdentifier("signin.reveal")
      }
    }
    if door != .signIn {
      AuthField(symbol: "lock.rotation", active: focus == .again || focus == .againShown) {
        focus = reveal ? .againShown : .again
      } content: {
        PasswordField(
          title: "Нууц үгээ давтах",
          text: $again,
          reveal: reveal,
          content: .newPassword,
          focus: $focus,
          hidden: .again,
          shown: .againShown,
        )
        .submitLabel(.go)
        .onSubmit { Task { await go() } }
        .accessibilityIdentifier("signin.again")
      }
    }
  }

  /// Another door: what the last one said no longer applies. What was typed
  /// stays where it still means the same thing — the login a forgotten
  /// password is for, the password a taken number should sign in with.
  private func open(_ next: Door) {
    door = next
    trouble = nil
    offerSignUp = false
    again = ""
    startLetterOver()
    // A forgotten password is replaced, not typed again; and a number typed
    // to sign in is not an address to sign up with.
    if next == .forgot { password = "" }
    if next == .signUp, byEmail, !login.contains("@") { login = "" }
  }

  /// A letter for a login nobody is typing any more is no use.
  private func startLetterOver() {
    letterFor = nil
    letterSentTo = nil
    letterCode = ""
  }

  private func switchTo(_ next: Way) {
    way = next
    trouble = nil
    offerSignUp = false
    focus = nil
  }

  @ViewBuilder private var troubleView: some View {
    if let trouble {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "exclamationmark.circle.fill")
            .font(.sans(14))
            .foregroundStyle(Color.stop)
          Text(trouble)
            .font(.sans(13.5))
            .foregroundStyle(Color.stop)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("signin.trouble")
        }
        if offerSignUp {
          Button("Шинэ хэрэглэгч бол бүртгүүлэх") { open(.signUp) }
            .font(.sans(14, .semibold))
            .tint(Color.accent)
            .accessibilityIdentifier("signin.offerSignUp")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(Color.stopSoft, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
      .transition(.opacity.combined(with: .scale(scale: 0.98)))
    }
  }

  @ViewBuilder private var developerDoor: some View {
    #if DEBUG
      if Endpoint.base != Endpoint.pilot && !showsAccount {
        VStack(spacing: 6) {
          Button("Хөгжүүлэгчийн сервер: шууд нэвтрэх") {
            Task {
              busy = true
              defer { busy = false }
              do {
                // Whichever number is typed, or the demo guest's.
                let typed = [login, phone].first(where: PhoneNumber.looksComplete).map(PhoneNumber.e164)
                try await session.demoSignIn(phone: typed ?? "+97699001122")
                signedIn()
              } catch {
                trouble = (error as? APIError)?.message ?? "Нэвтэрч чадсангүй."
              }
            }
          }
          .font(.sans(13, .medium))
          .tint(Color.accent)
          .accessibilityIdentifier("signin.demo")
          Text("Зөвхөн debug build, зөвхөн хөгжүүлэгчийн өөрийн сервер дээр.")
            .font(.sans(11.5))
            .foregroundStyle(Color.ink3)
        }
        .padding(.top, 18)
      }
    #endif
  }

  // MARK: - words

  private var title: String {
    if showsAccount { return "Бүртгэл" }
    guard way == .password else { return "Нэвтрэх" }
    switch door {
    case .signIn: return "Нэвтрэх"
    case .signUp: return "Бүртгүүлэх"
    case .forgot: return "Нууц үг сэргээх"
    }
  }

  private var footer: String {
    if lettered, let sent = letterSentTo {
      let letter = "\(sent) хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
      return door == .forgot ? letter + " Шинэ нууц үг тавихад бусад төхөөрөмжөөс гарна." : letter
    }
    switch door {
    case .signIn:
      return "Кирилл үсэгтэй нууц үгийг нүдэн тэмдгийг дараад бичнэ."
    case .signUp:
      return byEmail
        ? "Хаяг руу тань 6 оронтой код илгээнэ. Кодоо оруулмагц бүртгэл үүснэ. Нууц үгээ мартвал мөн энэ хаягаар сэргээнэ."
        : "Утасны дугаар, өөрийн сонгосон нууц үгээр бүртгэл үүснэ. Нууц үгээ хэнд ч бүү хэл."
    case .forgot:
      return "Бүртгэлтэй имэйл эсвэл утасны дугаараа бичнэ үү. Бүртгэлийн имэйл рүү тань код илгээнэ."
    }
  }

  private var action: String {
    switch door {
    case .signIn: "Нэвтрэх"
    case .signUp: byEmail && !lettered ? "Код авах" : "Бүртгүүлэх"
    case .forgot: lettered ? "Нууц үгээ шинэчлэх" : "Код авах"
    }
  }

  private var ready: Bool {
    guard !busy else { return false }
    let passwords = !password.isEmpty && !again.isEmpty
    switch door {
    case .signIn:
      return Session.looksLikeLogin(login) && !password.isEmpty
    case .signUp where byEmail:
      return login.contains("@") && passwords && (!lettered || letterCode.count == 6)
    case .signUp:
      return PhoneNumber.looksComplete(phone) && passwords
    case .forgot:
      return lettered ? letterCode.count == 6 && passwords : Session.looksLikeLogin(login)
    }
  }

  // MARK: - the calls

  /**
   Whichever door it was, the sheet goes at once, with the doors still on it,
   and the launcher's list and the profile catch up behind it. At once
   because iOS offers to keep a password the moment its field leaves the
   screen; offered over this sheet, the offer would hold the sheet open.

   The gate has nothing to close and nothing to catch up: the root swaps it
   for the launcher as soon as the session exists, and the launcher asks for
   its list on arrival.
   */
  private func signedIn() {
    guard !gate else { return }
    dismiss()
    Task {
      await model.refreshLive()
      await platform.refresh()
    }
  }

  private func askForCode() async {
    guard !busy, Session.address(email).contains("@") else { return }
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      try await session.requestCode(email: email)
      codeSentTo = Session.address(email)
      emailCode = ""
      focus = .emailCode
    } catch let error as APIError {
      trouble = error.message
    } catch {
      trouble = "Код илгээж чадсангүй. Дахин оролдоно уу."
    }
  }

  private func checkEmailCode() async {
    guard !busy, let sent = codeSentTo, emailCode.count == 6 else { return }
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      try await session.signIn(email: sent, code: emailCode)
      signedIn()
    } catch let error as APIError {
      trouble = error.message
      emailCode = ""
      focus = .emailCode
    } catch {
      trouble = "Нэвтэрч чадсангүй. Дахин оролдоно уу."
    }
  }

  private func signInWithGoogle() async {
    guard !busy else { return }
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      let back = try await webAuthenticationSession.authenticate(
        using: session.googleStart,
        callback: .customScheme(GoogleReturn.scheme),
        // Shared with Safari, so a Google account already signed in there
        // is one tap rather than a password.
        preferredBrowserSession: .shared,
        additionalHeaderFields: [:],
      )
      switch GoogleReturn.parse(back) {
      case .token(let token):
        session.signedInWithGoogle(token: token)
        signedIn()
      case .cancelled:
        break
      case .refused(let why):
        trouble = GoogleReturn.words(for: why)
      }
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      // Closed the sheet: nothing happened, nothing to say.
    } catch {
      trouble = GoogleReturn.words(for: "SOCIAL_REFUSED")
    }
  }

  private func signInWithApple(_ result: Result<ASAuthorization, Error>) async {
    switch result {
    case .failure(let error):
      if (error as? ASAuthorizationError)?.code == .canceled { return }
      trouble = "Apple-ээр нэвтэрч чадсангүй. Дахин оролдоно уу."
    case .success(let authorization):
      guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let data = credential.identityToken,
            let identityToken = String(data: data, encoding: .utf8)
      else {
        trouble = "Apple-ээр нэвтэрч чадсангүй. Дахин оролдоно уу."
        return
      }
      // Apple says the name once, the first time, and only to the app.
      let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) }
      busy = true
      trouble = nil
      defer { busy = false }
      do {
        try await session.signIn(appleToken: identityToken, nonce: appleNonce, name: name?.isEmpty == false ? name : nil)
        signedIn()
      } catch let error as APIError {
        trouble = error.message
      } catch {
        trouble = "Apple-ээр нэвтэрч чадсангүй. Дахин оролдоно уу."
      }
    }
  }

  private func go() async {
    guard ready else { return }
    // Checked here rather than left to the server: a mistyped repeat is the
    // one mistake the person can see for themselves. A reset's passwords are
    // typed after its code has gone, so until then there are none to check.
    if door != .signIn, door != .forgot || lettered {
      if password.count < 8 {
        trouble = "Нууц үг дор хаяж 8 тэмдэгт байх ёстой."
        focus = reveal ? .passwordShown : .password
        return
      }
      if password != again {
        trouble = "Хоёр нууц үг таарахгүй байна."
        focus = reveal ? .againShown : .again
        return
      }
    }
    // By email, a code to the inbox first, then the password it is for.
    if door == .forgot || (door == .signUp && byEmail) {
      if lettered { await setPassword() } else { await askForLetter() }
      return
    }
    busy = true
    trouble = nil
    offerSignUp = false
    defer { busy = false }
    do {
      switch door {
      case .signIn: try await session.signIn(login: login, password: password)
      case .signUp, .forgot: try await session.register(phone: phone, password: password)
      }
      signedIn()
    } catch let error as APIError {
      // «Already has an account — sign in»: the door it points at, with the
      // number and password still typed in.
      if error.code == "PHONE_TAKEN" {
        login = phone
        open(.signIn)
      }
      trouble = error.message
      offerSignUp = door == .signIn && error.code == "BAD_CREDENTIALS"
    } catch {
      trouble = "Нэвтэрч чадсангүй. Дахин оролдоно уу."
    }
  }

  /// A code to the inbox the login names: the address itself for a sign-up,
  /// the one on the account for a forgotten password. A number with no
  /// address behind it is refused, and the server says what to do instead.
  private func askForLetter() async {
    guard !busy, door == .signUp || door == .forgot else { return }
    busy = true
    trouble = nil
    offerSignUp = false
    defer { busy = false }
    do {
      letterSentTo = try await session.requestPasswordCode(
        login: login,
        purpose: door == .forgot ? .reset : .signUp,
      )
      letterFor = Session.login(login)
      letterCode = ""
      focus = .letterCode
    } catch let error as APIError {
      trouble = error.message
    } catch {
      trouble = "Код илгээж чадсангүй. Дахин оролдоно уу."
    }
  }

  /**
   The code and the password: an account made, or a password replaced, and a
   session either way.

   Said once over wherever the person lands when it was not quite what they
   asked for — a sign-up that found an account already on the address — or
   did more than they saw: a reset signs every other device out.
   */
  private func setPassword() async {
    guard !busy, let sentFor = letterFor, letterCode.count == 6 else { return }
    let forgot = door == .forgot
    let typedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      let created = try await session.setPassword(
        login: sentFor,
        code: letterCode,
        password: password,
        name: forgot || typedName.isEmpty ? nil : typedName,
      )
      if forgot {
        model.notice = "Нууц үг шинэчлэгдлээ. Бусад төхөөрөмжөөс гаргалаа."
      } else if !created {
        model.notice = "Энэ имэйлээр бүртгэл байсан — нууц үгийг нь шинэчилж нэвтэрлээ."
      }
      signedIn()
    } catch let error as APIError {
      trouble = error.message
      if error.code == "TOO_SHORT" {
        focus = reveal ? .passwordShown : .password
      } else {
        // A wrong, spent or stale code: the field empties for the next one.
        letterCode = ""
        focus = .letterCode
      }
    } catch {
      trouble = "Нэвтэрч чадсангүй. Дахин оролдоно уу."
    }
  }
}

/// Google's button as its guidelines draw it: the four-colour mark on white
/// (on the dark ground, on the dark surface), a hairline, the words — the
/// same height and corner as Apple's above it.
private struct GoogleButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image("GoogleG")
          .resizable()
          .frame(width: 18, height: 18)
        Text("Google-ээр нэвтрэх")
          .font(.sans(17, .medium))
          .foregroundStyle(Color.ink)
      }
      .frame(maxWidth: .infinity)
      .frame(height: BasuMetric.controlHeight)
      .background(Color.surface, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous)
          .strokeBorder(Color.line2, lineWidth: BasuMetric.hairline),
      )
    }
    .buttonStyle(Pressable())
  }
}

// MARK: - the way in's parts

/// The ground: warm white, or near black. The photograph is the colour.
private struct Backdrop: View {
  var body: some View {
    LinearGradient.ground
  }
}

extension View {
  /// The one card the way in sits on: glass, a hairline, a wide corner.
  fileprivate func authCard() -> some View {
    glassCard(radius: BasuMetric.authCard)
  }
}

/**
 A field: its mark, what is typed, and a ring that lights when it is the one
 being typed in. The whole of it takes the tap, not only the text — the mark
 is part of the target.
 */
private struct AuthField<Content: View>: View {
  let symbol: String
  let active: Bool
  let tap: () -> Void
  @ViewBuilder let content: Content

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous) }

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.sans(16))
        .foregroundStyle(active ? Color.accent : Color.ink3)
        .frame(width: 22)
        .accessibilityHidden(true)
      content
        .font(.sans(16))
        .foregroundStyle(Color.ink)
    }
    .padding(.horizontal, 14)
    .frame(height: BasuMetric.controlHeight)
    .background(Color.surface, in: shape)
    .overlay(shape.strokeBorder(active ? Color.accent : Color.line2, lineWidth: active ? 1.5 : BasuMetric.hairline))
    .contentShape(shape)
    .onTapGesture(perform: tap)
    .animation(.easeOut(duration: 0.15), value: active)
  }
}

/**
 Six digits in six boxes. The boxes are drawn; the typing goes to one plain
 field laid over them with its ink cleared, so pasting, the keyboard's
 «From Mail» suggestion and VoiceOver all see an ordinary text field.
 */
private struct CodeInput<Field: Hashable>: View {
  @Binding var code: String
  var focus: FocusState<Field?>.Binding
  let field: Field
  let id: String

  var body: some View {
    let digits = Array(code)
    let typing = focus.wrappedValue == field
    ZStack {
      HStack(spacing: 8) {
        ForEach(0..<6, id: \.self) { index in
          let shape = RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous)
          let next = typing && index == min(digits.count, 5)
          Text(index < digits.count ? String(digits[index]) : "")
            .font(.mono(22, .semibold))
            .foregroundStyle(Color.ink)
            .frame(maxWidth: .infinity)
            .frame(height: BasuMetric.controlHeight + 4)
            .background(Color.surface, in: shape)
            .overlay(shape.strokeBorder(next ? Color.accent : Color.line2, lineWidth: next ? 1.5 : BasuMetric.hairline))
        }
      }
      .allowsHitTesting(false)
      .accessibilityHidden(true)

      TextField("", text: $code)
        .keyboardType(.numberPad)
        .textContentType(.oneTimeCode)
        .focused(focus, equals: field)
        .foregroundStyle(.clear)
        .tint(.clear)
        .frame(height: BasuMetric.controlHeight + 4)
        .accessibilityLabel("Имэйлд ирсэн код")
        .accessibilityIdentifier(id)
    }
    .animation(.easeOut(duration: 0.12), value: code)
  }
}

/// The one thing the card is for, in the accent, with the wait shown in place.
private struct PrimaryButton: View {
  let title: String
  let enabled: Bool
  let busy: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        if busy {
          ProgressView().tint(Color.onAccent)
        } else {
          Text(title).font(.sans(16, .semibold))
        }
      }
      .foregroundStyle(Color.onAccent)
      .frame(maxWidth: .infinity)
      .frame(height: BasuMetric.controlHeight)
      .background(Color.accent, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
    }
    .buttonStyle(Pressable())
    .disabled(!enabled)
    .opacity(enabled || busy ? 1 : 0.45)
    .animation(.easeOut(duration: 0.15), value: enabled)
  }
}

/// Shrinks a touch under the thumb: the only answer a tap gets before the server's.
private struct Pressable: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
      .opacity(configuration.isPressed ? 0.9 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

/// A rule, a word, a rule — between the one-tap doors and the typed one.
private struct OrLine: View {
  let words: String

  var body: some View {
    HStack(spacing: 10) {
      Rectangle().fill(Color.line).frame(height: BasuMetric.hairline)
      Text(words)
        .font(.sans(12.5))
        .foregroundStyle(Color.ink3)
        .fixedSize()
      Rectangle().fill(Color.line).frame(height: BasuMetric.hairline)
    }
  }
}

/// The small print under a field: what happens next, and where the code goes.
private struct Note: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.sans(12.5))
      .lineSpacing(2)
      .foregroundStyle(Color.ink3)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Another way in, off the card: a mark, the words, and where it leads.
private struct WayButton: View {
  let title: String
  var detail: String?
  let symbol: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: symbol)
          .font(.sans(15, .medium))
          .foregroundStyle(Color.accent)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.sans(15, .medium))
            .foregroundStyle(Color.ink)
          if let detail {
            Text(detail)
              .font(.sans(12.5))
              .foregroundStyle(Color.ink3)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .multilineTextAlignment(.leading)
        Spacer(minLength: 8)
        Chevron(size: 12).foregroundStyle(Color.ink3)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .glassCard(radius: BasuMetric.control)
      .contentShape(Rectangle())
    }
    .buttonStyle(Pressable())
  }
}

/// «Нэвтрэх | Бүртгүүлэх»: two halves of one pill, the chosen one lifted.
private struct DoorSwitch: View {
  @Binding var door: SignInSheet.Door
  @Namespace private var pill

  var body: some View {
    HStack(spacing: 4) {
      half(.signIn, "Нэвтрэх", id: "signin.door.signIn")
      half(.signUp, "Бүртгүүлэх", id: "signin.door.signUp")
    }
    .padding(4)
    .background(Color.sunk.opacity(0.7), in: Capsule())
    .overlay(Capsule().strokeBorder(Color.line, lineWidth: BasuMetric.hairline))
    .sensoryFeedback(.selection, trigger: door)
  }

  private func half(_ which: SignInSheet.Door, _ title: String, id: String) -> some View {
    let chosen = door == which
    return Button {
      withAnimation(.snappy(duration: 0.25)) { door = which }
    } label: {
      Text(title)
        .font(.sans(15, chosen ? .semibold : .medium))
        .foregroundStyle(chosen ? Color.ink : Color.ink2)
        .frame(maxWidth: .infinity)
        .frame(height: 40)
        .background {
          if chosen {
            Capsule()
              .fill(Color.surface)
              .overlay(Capsule().strokeBorder(Color.line, lineWidth: BasuMetric.hairline))
              .shadow(color: Color.tileShadow, radius: 2, y: 1)
              .matchedGeometryEffect(id: "pill", in: pill)
          }
        }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(chosen ? [.isSelected] : [])
    .accessibilityIdentifier(id)
  }
}

/// A one-time value for Sign in with Apple: the hash goes to Apple inside the
/// request, the value itself to our server, which checks the two agree.
enum Nonce {
  static func make() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

/**
 A password, hidden or shown. Shown, it must not be "helped": no capital
 letter at the start, no autocorrected word.

 Both fields stay on screen, one of them invisible, rather than one taking
 the other's place: a filled password field leaving the screen is how iOS
 recognises a sign-in, and swapping them made it offer «Save Password?» for
 whatever had been typed so far.

 Generic over the screen's own focus: the way in has one set of fields, the
 profile's password and address sheets another.
 */
struct PasswordField<Field: Hashable>: View {
  let title: String
  @Binding var text: String
  let reveal: Bool
  let content: UITextContentType
  var focus: FocusState<Field?>.Binding
  let hidden: Field
  let shown: Field

  var body: some View {
    ZStack {
      SecureField(title, text: $text)
        .focused(focus, equals: hidden)
        .opacity(reveal ? 0 : 1)
        .allowsHitTesting(!reveal)
        .accessibilityHidden(reveal)
      TextField(title, text: $text)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused(focus, equals: shown)
        .opacity(reveal ? 1 : 0)
        .allowsHitTesting(reveal)
        .accessibilityHidden(!reveal)
    }
    .textContentType(content)
  }
}

/**
 The eye beside a password. A secure field on iOS offers only keyboards that
 type Latin, and a password chosen on the web may be in Cyrillic — shown, the
 field takes the Mongolian keyboard like any other.

 Turned, the keyboard moves to the twin that is now on show, where the same
 characters already are.
 */
struct RevealButton<Field: Hashable>: View {
  @Binding var reveal: Bool
  var focus: FocusState<Field?>.Binding
  /// Every password on the screen, as its hidden field and its shown one.
  let twins: [(hidden: Field, shown: Field)]

  var body: some View {
    Button {
      reveal.toggle()
      if let now = focus.wrappedValue,
         let twin = twins.first(where: { $0.hidden == now || $0.shown == now }) {
        focus.wrappedValue = reveal ? twin.shown : twin.hidden
      }
    } label: {
      Image(systemName: reveal ? "eye.slash" : "eye")
        .font(.sans(15))
        .foregroundStyle(Color.ink3)
        .frame(width: 28, height: 28)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(reveal ? "Нууц үгийг нуух" : "Нууц үгийг харуулах")
  }
}
