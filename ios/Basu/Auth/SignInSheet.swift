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

 Typing happens with the keyboard over half the screen, so the screen moves
 with the keyboard rather than hiding things under it: the field being typed
 in is brought to the middle, a refusal is said under the field it is about
 (and felt — the phone buzzes), and while a code is awaited the photograph
 and the other doors fold away, so the code, what went wrong with it and the
 button are all above the keys. The fields, the code boxes and the button are
 in `AuthParts.swift`, shared with the profile's own sheets.

 A debug build pointed at a developer's own server has one more button, which
 goes straight to a session the way that server allows. It is compiled out of
 anything shipped, and hidden against the pilot, which has no such door.
 */
struct SignInSheet: View {
  /// The whole screen of a signed-out app rather than a sheet over something:
  /// the wordmark on top, nothing to close, nothing to dismiss once in.
  var gate = false
  /// Why a page inside the app asked, said under the title: a sheet that
  /// arrives mid-order should say what it is for and that nothing was lost.
  var reason: String?

  /// Which face the sheet shows: the doors most people take, or the password.
  enum Way: Hashable { case doors, password }
  enum Door: Hashable { case signIn, signUp, forgot }
  /// The door waiting on an answer. The wait is shown in that one — a tap on
  /// Google used to spin the email button, the only one with a spinner.
  enum Busy: Hashable { case apple, google, email, password }
  /// Where a refusal is said: beside the door that was refused.
  enum Spot: Hashable { case social, email, password }
  /// Each password has two fields, one hidden and one shown — see `PasswordField`.
  fileprivate enum Field: Hashable {
    case email, emailCode, name, login, letterCode, phone, password, passwordShown, again, againShown
  }
  /// The refusal, as a place the screen can be scrolled to.
  private enum Mark: Hashable { case trouble }

  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model
  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @Environment(\.webAuthenticationSession) private var webAuthenticationSession

  @State private var way: Way = .doors
  /// Whether the sheet opened on somebody already signed in. A sign-in made
  /// here does not turn the sheet into the account view: it closes with the
  /// doors still on it.
  @State private var arrivedSignedIn: Bool?
  /// Asked of the server when the sheet opens. Until it answers, what it said
  /// last time, so a slow network does not draw the way in a door at a time;
  /// nil only the first time, when the doors' places are kept instead.
  @State private var methods: AuthMethods? = Session.rememberedMethods()
  @State private var methodsAsked = false
  /// Google's button grows with the text and Apple's must not be smaller:
  /// the height Google's took, for Apple's to take too.
  @State private var doorHeight: CGFloat = BasuMetric.controlHeight
  @State private var busy: Busy?
  @State private var trouble: String?
  @State private var troubleAt: Spot = .email

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
      ScrollViewReader { scroller in
        ScrollView {
          VStack(spacing: 0) {
            if gate {
              browse
              // Waiting for a code, the picture is only in the way of it.
              if !codeStep { hero }
            } else if !showsAccount {
              sheetHead
            }
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
        // Signed out there is no bar over the gate, and the photograph and
        // the fields scrolled up under the clock. The strip keeps the time
        // on the ground.
        .overlay(alignment: .top) {
          if gate { StatusBarBackdrop() }
        }
        .onChange(of: focus) { _, field in
          guard let field else { return }
          bring(anchor(of: field), to: .center, with: scroller)
        }
        .onChange(of: trouble) { _, said in
          guard said != nil else { return }
          bring(Mark.trouble, to: .center, with: scroller)
        }
      }
      // A refusal is felt as well as read: a wrong code empties the boxes,
      // and with the phone in one hand that is easy to miss.
      .sensoryFeedback(.error, trigger: trouble) { _, said in said != nil }
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
      // Asked once a sheet, whatever was remembered: the doors drawn from
      // last time are replaced by today's as soon as the server says.
      guard !methodsAsked else { return }
      methodsAsked = true
      let open = await session.methods()
      methods = open
      // A server with no door but the password: the password is the sheet.
      if !open.apple && !open.google && !open.email { way = .password }
    }
  }

  /// A code is on its way and the screen is waiting for it.
  private var codeStep: Bool { codeSentTo != nil || lettered }

  /// The field's place on the screen; a password's twins share one.
  private func anchor(of field: Field) -> Field {
    switch field {
    case .passwordShown: .password
    case .againShown: .again
    default: field
    }
  }

  /**
   Scroll something into the middle of what the keyboard leaves. A beat
   later than asked: focus moves first and the keyboard follows, and until it
   has risen the middle is the middle of the whole screen.
   */
  private func bring(_ id: some Hashable, to anchor: UnitPoint, with scroller: ScrollViewProxy) {
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(320))
      withAnimation(.snappy(duration: 0.3)) { scroller.scrollTo(id, anchor: anchor) }
    }
  }

  // MARK: - the head

  /// What the first face says under the wordmark. Winter meat first, because
  /// it is what can be bought today; lunch after it.
  private static let tagline = "Өвлийн идшээ гэрээт нийлүүлэгчээс ав, хоолоо урьдчилан захиал."

  /**
   The gate's head: a photograph of what Basu is for, the wordmark on it in
   white, and one line that says it — the web's front page in miniature.
   Past the first face, and while anything is typed, the picture folds to a
   band so the fields and the keyboard both fit, and the line becomes the
   door that is open.

   The words decide the height and the picture fills behind them, not the
   other way round: at the largest text sizes the line needs more than the
   photograph's 210 points, and it grows the head rather than spilling off it.

   The buuz are Tuguldur Baatar's, from Unsplash (free for commercial use;
   credited with the web's photographs in src/web/brand/meat/CREDITS.txt).
   */
  private var hero: some View {
    let first = way == .doors
    let small = !first || focus != nil
    let shape = RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous)
    return VStack(alignment: .leading, spacing: 8) {
      Text("Basu")
        .font(.display(small ? 36 : 56))
      Text(first ? Self.tagline : title)
        .font(.sans(first ? 15 : 17, first ? .semibold : .bold))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .contentTransition(.opacity)
    }
    .foregroundStyle(Color.ink)
    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    .padding(.horizontal, 20)
    .padding(.vertical, 20)
    .frame(
      maxWidth: .infinity,
      minHeight: small ? BasuMetric.authPhoto * 0.55 : BasuMetric.authPhoto,
      alignment: .bottomLeading,
    )
    .background {
      ZStack {
        Image("SignInPhoto")
          .resizable()
          .scaledToFill()
          // The web's warm grade for a pale photograph: a touch of sepia's
          // warmth, more colour, more contrast — the meat lit, the rest dark.
          .saturation(1.2)
          .contrast(1.12)
        // The photograph settles into the charcoal at its foot, so the words
        // stand on the ground rather than on a grey smudge.
        LinearGradient(
          stops: [
            .init(color: Color.bg.opacity(0.0), location: 0.2),
            .init(color: Color.bg.opacity(0.7), location: 0.62),
            .init(color: Color.bg.opacity(0.96), location: 1),
          ],
          startPoint: .top,
          endPoint: .bottom,
        )
      }
      // The picture fills past the band when the band is small; clipped to
      // the eye but not to the thumb, it lay over «Бүртгэлгүйгээр үзэх».
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
    .clipShape(shape)
    .contentShape(shape)
    .overlay(shape.strokeBorder(Color.line, lineWidth: BasuMetric.hairline))
    .padding(.top, 8)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Basu. \(first ? Self.tagline : title)")
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("signin.gate")
  }

  /**
   «Бүртгэлгүйгээр үзэх», at the top where it is seen before anything is
   typed: looking needs no account; ordering, the wallet and the profile do
   (App Review guideline 5.1.1(v)).
   */
  private var browse: some View {
    HStack {
      Spacer()
      Button { model.browsing = true } label: {
        HStack(spacing: 6) {
          Text("Бүртгэлгүйгээр үзэх")
            .lineLimit(1)
            .minimumScaleFactor(0.8)
          Image(systemName: "arrow.right")
        }
        // One line at every size: grown past this it broke mid-word.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .font(.sans(14, .bold))
        .foregroundStyle(Color.ink)
        .padding(.horizontal, 16)
        .frame(minHeight: BasuMetric.minTarget)
        .glass(in: Capsule())
        .contentShape(Capsule())
      }
      .buttonStyle(Pressable())
      .accessibilityIdentifier("signin.browse")
    }
  }

  /// A sheet over a page: no photograph, the title large and on the ground —
  /// and, when a page asked, why.
  private var sheetHead: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.display(44))
        .foregroundStyle(Color.ink)
        .accessibilityAddTraits(.isHeader)
      if let reason, !codeStep {
        Text(reason)
          .font(.sans(15, .medium))
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("signin.reason")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 4)
  }

  /// The two pages every way in is under, one tap from the door.
  private var legal: some View {
    HStack(spacing: 6) {
      Link("Үйлчилгээний нөхцөл", destination: Endpoint.base.appending(path: "terms"))
        .frame(minHeight: BasuMetric.minTarget)
      Text("·").foregroundStyle(Color.ink3)
      Link("Нууцлалын бодлого", destination: Endpoint.base.appending(path: "privacy"))
        .frame(minHeight: BasuMetric.minTarget)
    }
    .font(.sans(13, .semibold))
    .tint(Color.ink3)
    .padding(.top, 16)
  }

  // MARK: - signed in

  private var showsAccount: Bool { (arrivedSignedIn ?? session.isSignedIn) && session.isSignedIn }

  private var account: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        if let phone = platform.me?.phone ?? session.phone {
          Text("Утас").font(.sans(13)).foregroundStyle(Color.ink3)
          Text(phone).font(.sans(16, .semibold)).monospacedDigit().foregroundStyle(Color.ink)
        } else if let email = platform.me?.email ?? session.email {
          Text("Имэйл").font(.sans(13)).foregroundStyle(Color.ink3)
          Text(email).font(.sans(16)).foregroundStyle(Color.ink)
        }
      }
      WideButton(title: "Гарах", kind: .quiet) {
        platform.signOut()
        Task { await model.refreshLive() }
        dismiss()
      }
      Text("Гарсан ч захиалга тань хэвээр. Дахин нэвтэрвэл гарч ирнэ.")
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
        // Waiting for a code, the other doors fold into one row under the
        // card: two big buttons above a code nobody asked them about is what
        // pushed the code under the keyboard.
        if codeSentTo == nil {
          appleButton

          if methods?.google == true {
            GoogleButton(busy: busy == .google) { Task { await signInWithGoogle() } }
              .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                doorHeight = max(BasuMetric.controlHeight, $0)
              }
              .accessibilityIdentifier("signin.google")
          }

          refusal(at: .social)
        }

        if methods?.email == true {
          if codeSentTo == nil {
            OrLine(words: "эсвэл имэйлээр")
              .padding(.vertical, 4)
          }
          emailDoor
        } else if methods == nil {
          // The first time, before the server has said which doors it has:
          // their places, so the card does not grow under the thumb.
          DoorsPlaceholder()
        }
      }
      .disabled(busy != nil && codeSentTo == nil)
      .padding(18)
      .authCard()

      if codeSentTo != nil {
        WayButton(
          title: "Өөр аргаар нэвтрэх",
          detail: "Apple, Google эсвэл нууц үгээр",
          symbol: "arrow.uturn.backward",
        ) {
          focus = nil
          startOver()
        }
        .accessibilityIdentifier("signin.otherWays")
      } else {
        WayButton(
          title: "Нууц үгээр нэвтрэх, бүртгүүлэх",
          detail: "Имэйл эсвэл утас, нууц үгээр",
          symbol: "key",
        ) { switchTo(.password) }
          .accessibilityIdentifier("signin.passwordWay")
      }
    }
  }

  /**
   Apple's own button, in its white style: on a dark ground that is the
   guidelines' own choice, and it needs no outline there. A capsule, as every
   button in Basu is — the guidelines let its corner follow the app's — and
   the twin of Google's under it, so the crimson button is the one strong
   colour on the card.
   */
  private var appleButton: some View {
    SignInWithAppleButton(.signIn) { request in
      let nonce = Nonce.make()
      appleNonce = nonce
      request.requestedScopes = [.fullName, .email]
      request.nonce = Nonce.sha256(nonce)
    } onCompletion: { result in
      Task { await signInWithApple(result) }
    }
    .signInWithAppleButtonStyle(.white)
    // Never smaller than the other doors (Apple's rule), however large the text.
    .frame(height: doorHeight)
    .clipShape(Capsule())
    .overlay {
      if busy == .apple {
        ZStack {
          Capsule().fill(Color.surface)
          ProgressView().tint(Color.ink)
        }
        .transition(.opacity)
      }
    }
    .accessibilityIdentifier("signin.apple")
  }

  @ViewBuilder private var emailDoor: some View {
    AuthField(symbol: "envelope", active: focus == .email) { focus = .email } content: {
      TextField("Имэйл хаяг", text: $email, prompt: placeholder("Имэйл хаяг"))
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
    .id(Field.email)

    if codeSentTo != nil {
      CodeInput(code: $emailCode, focus: $focus, field: .emailCode, id: "signin.emailCode")
        .onChange(of: emailCode) { _, typed in
          let digits = String(typed.filter(\.isNumber).prefix(6))
          if digits != typed { emailCode = digits }
          // Six digits is the whole code: pasted or typed, it goes
          // without another tap.
          if digits.count == 6 { Task { await checkEmailCode() } }
        }
        .id(Field.emailCode)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // Right under the field it is about, above the small print.
    refusal(at: .email)

    Note(text: emailFooter)

    PrimaryButton(title: codeSentTo == nil ? "Код авах" : "Нэвтрэх", enabled: emailReady, busy: busy == .email) {
      Task { if codeSentTo == nil { await askForCode() } else { await checkEmailCode() } }
    }
    .accessibilityIdentifier("signin.emailGo")

    if codeSentTo != nil {
      HStack {
        QuietLink("Код дахин авах") { Task { await askForCode() } }
          .accessibilityIdentifier("signin.resend")
        Spacer()
        QuietLink("Хаяг солих") {
          startOver()
          focus = .email
        }
      }
      .padding(.vertical, -8)
    }
  }

  private var emailFooter: String {
    if let sent = codeSentTo {
      return "\(sent) хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
    }
    return "Хаяг руу тань 6 оронтой код илгээнэ. Анх удаа бол бүртгэл шууд үүснэ."
  }

  private var emailReady: Bool {
    guard busy == nil else { return false }
    if codeSentTo == nil { return Session.address(email).contains("@") }
    return emailCode.count == 6
  }

  private func startOver() {
    codeSentTo = nil
    emailCode = ""
    if troubleAt == .email { trouble = nil }
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

        refusal(at: .password)
        Note(text: footer)

        PrimaryButton(title: action, enabled: ready, busy: busy == .password) {
          Task { await go() }
        }
        .accessibilityIdentifier("signin.go")

        if door == .signIn && byEmail {
          QuietLink("Нууц үгээ мартсан?") { open(.forgot) }
            .padding(.vertical, -8)
            .accessibilityIdentifier("signin.forgot")
        } else if lettered {
          QuietLink("Код дахин авах") { Task { await askForLetter() } }
            .padding(.vertical, -8)
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
          // A neutral mark: Apple's logo belongs on Apple's own button.
          WayButton(title: "Apple, Google эсвэл имэйлээр нэвтрэх", symbol: "person.badge.key") { switchTo(.doors) }
            .accessibilityIdentifier("signin.doorsWay")
        }
      }
    }
  }

  private var nameField: some View {
    AuthField(symbol: "person", active: focus == .name) { focus = .name } content: {
      TextField("Нэр", text: $name, prompt: placeholder("Нэр"))
        .textContentType(.name)
        .focused($focus, equals: .name)
        .submitLabel(.next)
        .onSubmit { focus = .login }
        .accessibilityIdentifier("signin.name")
    }
    .id(Field.name)
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
      TextField(door == .signUp ? "Имэйл хаяг" : "Имэйл эсвэл утас", text: $login, prompt: placeholder(door == .signUp ? "Имэйл хаяг" : "Имэйл эсвэл утас"))
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
    .id(Field.login)
  }

  private var phoneField: some View {
    AuthField(symbol: "phone", active: focus == .phone) { focus = .phone } content: {
      TextField("Утасны дугаар · 8811 2233", text: $phone, prompt: placeholder("Утасны дугаар · 8811 2233"))
        .keyboardType(.phonePad)
        .textContentType(.telephoneNumber)
        .font(.sans(16, .medium))
        .monospacedDigit()
        .focused($focus, equals: .phone)
        .accessibilityIdentifier("signin.phone")
    }
    .id(Field.phone)
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
    .id(Field.letterCode)
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
    .id(Field.password)
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
      .id(Field.again)
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

  /// A refusal, where it belongs — and nowhere else.
  @ViewBuilder private func refusal(at spot: Spot) -> some View {
    if let trouble, troubleAt == spot {
      TroubleNote(text: trouble) {
        if offerSignUp && spot == .password {
          Button("Шинэ хэрэглэгч бол бүртгүүлэх") { open(.signUp) }
            .font(.sans(14, .semibold))
            .tint(Color.ink)
            .frame(minHeight: 32)
            .accessibilityIdentifier("signin.offerSignUp")
        }
      }
      .id(Mark.trouble)
    }
  }

  /// Say no, beside the door that was refused.
  private func say(_ words: String, at spot: Spot) {
    troubleAt = spot
    trouble = words
  }

  @ViewBuilder private var developerDoor: some View {
    #if DEBUG
      if Endpoint.base != Endpoint.pilot && !showsAccount {
        VStack(spacing: 6) {
          Button("Хөгжүүлэгчийн сервер: шууд нэвтрэх") {
            Task {
              busy = .password
              defer { busy = nil }
              do {
                // Whichever number is typed, or the demo guest's.
                let typed = [login, phone].first(where: PhoneNumber.looksComplete).map(PhoneNumber.e164)
                try await session.demoSignIn(phone: typed ?? "+97699001122")
                signedIn()
              } catch {
                say((error as? APIError)?.message ?? "Нэвтэрч чадсангүй.", at: way == .password ? .password : .email)
              }
            }
          }
          .font(.sans(13, .medium))
          .tint(Color.ink)
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
    guard busy == nil else { return false }
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
    guard busy == nil, Session.address(email).contains("@") else { return }
    busy = .email
    trouble = nil
    defer { busy = nil }
    do {
      try await session.requestCode(email: email)
      codeSentTo = Session.address(email)
      emailCode = ""
      focus = .emailCode
    } catch let error as APIError {
      say(error.message, at: .email)
    } catch {
      say("Код илгээж чадсангүй. Дахин оролдоно уу.", at: .email)
    }
  }

  private func checkEmailCode() async {
    guard busy == nil, let sent = codeSentTo, emailCode.count == 6 else { return }
    busy = .email
    trouble = nil
    defer { busy = nil }
    do {
      try await session.signIn(email: sent, code: emailCode)
      signedIn()
    } catch let error as APIError {
      say(error.message, at: .email)
      emailCode = ""
      focus = .emailCode
    } catch {
      say("Нэвтэрч чадсангүй. Дахин оролдоно уу.", at: .email)
    }
  }

  private func signInWithGoogle() async {
    guard busy == nil else { return }
    busy = .google
    trouble = nil
    defer { busy = nil }
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
        say(GoogleReturn.words(for: why), at: .social)
      }
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      // Closed the sheet: nothing happened, nothing to say.
    } catch {
      say(GoogleReturn.words(for: "SOCIAL_REFUSED"), at: .social)
    }
  }

  private func signInWithApple(_ result: Result<ASAuthorization, Error>) async {
    switch result {
    case .failure(let error):
      if (error as? ASAuthorizationError)?.code == .canceled { return }
      say("Apple-ээр нэвтэрч чадсангүй. Дахин оролдоно уу.", at: .social)
    case .success(let authorization):
      guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let data = credential.identityToken,
            let identityToken = String(data: data, encoding: .utf8)
      else {
        say("Apple-ээр нэвтэрч чадсангүй. Дахин оролдоно уу.", at: .social)
        return
      }
      // Apple says the name once, the first time, and only to the app.
      let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) }
      busy = .apple
      trouble = nil
      defer { busy = nil }
      do {
        try await session.signIn(appleToken: identityToken, nonce: appleNonce, name: name?.isEmpty == false ? name : nil)
        signedIn()
      } catch let error as APIError {
        say(error.message, at: .social)
      } catch {
        say("Apple-ээр нэвтэрч чадсангүй. Дахин оролдоно уу.", at: .social)
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
        say("Нууц үг дор хаяж 8 тэмдэгт байх ёстой.", at: .password)
        focus = reveal ? .passwordShown : .password
        return
      }
      if password != again {
        say("Хоёр нууц үг таарахгүй байна.", at: .password)
        focus = reveal ? .againShown : .again
        return
      }
    }
    // By email, a code to the inbox first, then the password it is for.
    if door == .forgot || (door == .signUp && byEmail) {
      if lettered { await setPassword() } else { await askForLetter() }
      return
    }
    busy = .password
    trouble = nil
    offerSignUp = false
    defer { busy = nil }
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
      offerSignUp = door == .signIn && error.code == "BAD_CREDENTIALS"
      say(error.message, at: .password)
    } catch {
      say("Нэвтэрч чадсангүй. Дахин оролдоно уу.", at: .password)
    }
  }

  /// A code to the inbox the login names: the address itself for a sign-up,
  /// the one on the account for a forgotten password. A number with no
  /// address behind it is refused, and the server says what to do instead.
  private func askForLetter() async {
    guard busy == nil, door == .signUp || door == .forgot else { return }
    busy = .password
    trouble = nil
    offerSignUp = false
    defer { busy = nil }
    do {
      letterSentTo = try await session.requestPasswordCode(
        login: login,
        purpose: door == .forgot ? .reset : .signUp,
      )
      letterFor = Session.login(login)
      letterCode = ""
      focus = .letterCode
    } catch let error as APIError {
      say(error.message, at: .password)
    } catch {
      say("Код илгээж чадсангүй. Дахин оролдоно уу.", at: .password)
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
    guard busy == nil, let sentFor = letterFor, letterCode.count == 6 else { return }
    let forgot = door == .forgot
    let typedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    busy = .password
    trouble = nil
    defer { busy = nil }
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
      say(error.message, at: .password)
      if error.code == "TOO_SHORT" {
        focus = reveal ? .passwordShown : .password
      } else {
        // A wrong, spent or stale code: the field empties for the next one.
        letterCode = ""
        focus = .letterCode
      }
    } catch {
      say("Нэвтэрч чадсангүй. Дахин оролдоно уу.", at: .password)
    }
  }
}

/// Google's button as its guidelines draw it for a dark ground: the
/// four-colour mark on the surface, a hairline, the words — the same height
/// and capsule as Apple's above it, and its own wait.
private struct GoogleButton: View {
  var busy = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack {
        if busy {
          ProgressView().tint(Color.ink)
        } else {
          HStack(spacing: 10) {
            Image("GoogleG")
              .resizable()
              .frame(width: 18, height: 18)
              .accessibilityHidden(true)
            Text("Google-ээр нэвтрэх")
              .font(.sans(17, .semibold))
              .foregroundStyle(Color.ink)
              .multilineTextAlignment(.center)
          }
          // Apple's button beside it stops growing early; past this the
          // words broke at the hyphen into three lines.
          .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity)
      .frame(minHeight: BasuMetric.controlHeight)
      .background(Color.surface, in: Capsule())
      .overlay(Capsule().strokeBorder(Color.line2, lineWidth: BasuMetric.hairline))
      .contentShape(Capsule())
    }
    .buttonStyle(Pressable())
  }
}

// MARK: - the way in's parts

/// The ground: the charcoal. The photograph is the colour.
private struct Backdrop: View {
  var body: some View {
    Color.bg
  }
}

/**
 The strip under the clock, in the ground's colour. With no navigation bar
 over the gate, whatever scrolls up — the photograph, the fields — ran into
 the time; with it the time stays on the ground, the way it does under a
 bar. Nothing under it is ever reachable, so it takes no touches.
 */
private struct StatusBarBackdrop: View {
  var body: some View {
    Color.clear
      .frame(height: 0)
      .background(Color.bg.ignoresSafeArea(edges: .top))
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}

/**
 Where Google's door and the email door go, before the server has said it has
 them — only ever the first time; after that the doors it had last time are
 drawn. Shapes, not words: nothing here can be pressed.
 */
private struct DoorsPlaceholder: View {
  var body: some View {
    VStack(spacing: 12) {
      Capsule().fill(Color.surface3).frame(height: BasuMetric.controlHeight)
      Rectangle().fill(Color.line).frame(height: BasuMetric.hairline).padding(.vertical, 12)
      RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous)
        .fill(Color.surface3).frame(height: BasuMetric.controlHeight)
      Capsule().fill(Color.surface3.opacity(0.6)).frame(height: BasuMetric.buttonHeight)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Уншиж байна")
    .accessibilityIdentifier("signin.doorsLoading")
  }
}

/// A rule, a word, a rule — between the one-tap doors and the typed one.
private struct OrLine: View {
  let words: String

  var body: some View {
    HStack(spacing: 12) {
      Rectangle().fill(Color.line).frame(height: BasuMetric.hairline)
      Text(words)
        .font(.sans(13, .semibold))
        .foregroundStyle(Color.ink3)
        .fixedSize()
      Rectangle().fill(Color.line).frame(height: BasuMetric.hairline)
    }
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
      HStack(spacing: 14) {
        Image(systemName: symbol)
          .font(.sans(16, .medium))
          .foregroundStyle(Color.ink2)
          .dynamicTypeSize(...DynamicTypeSize.accessibility1)
          .frame(minWidth: 22)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(title)
            .font(.sans(15, .bold))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
          if let detail {
            Text(detail)
              .font(.sans(13, .medium))
              .foregroundStyle(Color.ink3)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .multilineTextAlignment(.leading)
        Spacer(minLength: 8)
        Chevron(size: 12).foregroundStyle(Color.ink3)
      }
      .padding(.horizontal, 18)
      .padding(.vertical, 16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .card(radius: BasuMetric.card)
      .contentShape(Rectangle())
    }
    .buttonStyle(Pressable())
  }
}

/// «Нэвтрэх | Бүртгүүлэх»: two halves of one capsule; the chosen one is the
/// off-white pill with dark words on it.
private struct DoorSwitch: View {
  @Binding var door: SignInSheet.Door
  @Namespace private var pill

  var body: some View {
    HStack(spacing: 4) {
      half(.signIn, "Нэвтрэх", id: "signin.door.signIn")
      half(.signUp, "Бүртгүүлэх", id: "signin.door.signUp")
    }
    .padding(4)
    .background(Color.surface, in: Capsule())
    .overlay(Capsule().strokeBorder(Color.line, lineWidth: BasuMetric.hairline))
    .sensoryFeedback(.selection, trigger: door)
  }

  private func half(_ which: SignInSheet.Door, _ title: String, id: String) -> some View {
    let chosen = door == which
    return Button {
      withAnimation(.snappy(duration: 0.25)) { door = which }
    } label: {
      Text(title)
        .font(.sans(15, .bold))
        .foregroundStyle(chosen ? Color.onLight : Color.ink2)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 46)
        .background {
          if chosen {
            Capsule()
              .fill(Color.ink)
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
