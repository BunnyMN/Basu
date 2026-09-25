import AuthenticationServices
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
 that locks for good. A supplier's owner the desk registered has a code
 from Basu to choose a password with, on the same face.

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
  enum Door: Hashable { case signIn, signUp, forgot, invite }
  /// Each password has two fields, one hidden and one shown — see `PasswordField`.
  fileprivate enum Field: Hashable {
    case email, emailCode, code, name, login, letterCode, phone, password, passwordShown, again, againShown
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
  /// The invitation's code, from Basu.
  @State private var code = ""
  /// The invitation's number, and a sign-up's when the server has no email.
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
      Form {
        if gate {
          wordmark
          if model.offline { offline }
        }
        if showsAccount {
          account
        } else if way == .password {
          passwordDoors
        } else {
          doors
        }
      }
      .navigationTitle(gate ? "" : title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if !gate {
          ToolbarItem(placement: .topBarLeading) {
            Button("Хаах") { dismiss() }
          }
        }
      }
      .toolbarVisibility(gate ? .hidden : .automatic, for: .navigationBar)
      .scrollContentBackground(gate ? .hidden : .automatic)
      .background {
        if gate { LinearGradient.ground.ignoresSafeArea() }
      }
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

  // MARK: - the gate's head

  /// The splash's wordmark and rule, at the splash's size, so the splash
  /// fading into this screen reads as one picture rather than a jump. Under
  /// them, which door is open — the words a sheet puts in its title bar.
  private var wordmark: some View {
    Section {
      VStack(spacing: 14) {
        Text("Basu")
          .font(.sans(44, .semibold))
          .tracking(-0.03 * 44)
          .foregroundStyle(Color.ink)
        RoundedRectangle(cornerRadius: 1, style: .continuous)
          .fill(Color.accent)
          .frame(width: 34, height: 2)
        Text(title)
          .font(.sans(15))
          .foregroundStyle(Color.ink2)
          .padding(.top, 4)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, 36)
      .padding(.bottom, 8)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Basu · \(title)")
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("signin.gate")
    }
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets())
  }

  /// Signed out, the gate is the whole app, so it says an unreachable server
  /// out loud the way the launcher does — rather than leaving a door that
  /// fails when knocked on. Once the server answers, it is asked again which
  /// doors are open.
  private var offline: some View {
    Section {
      OfflineBanner {
        await model.retry()
        if !model.offline { methods = await session.methods() }
      }
    }
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets())
  }

  // MARK: - signed in

  private var showsAccount: Bool { (arrivedSignedIn ?? session.isSignedIn) && session.isSignedIn }

  @ViewBuilder private var account: some View {
    Section {
      if let phone = platform.me?.phone ?? session.phone {
        LabeledContent("Утас", value: phone)
      } else if let email = platform.me?.email ?? session.email {
        LabeledContent("Имэйл", value: email)
      }
      Button("Гарах", role: .destructive) {
        session.signOut()
        Task { await model.refreshLive() }
        dismiss()
      }
    } footer: {
      Text("Гарсан ч захиалга чинь хэвээр. Дахин нэвтэрвэл гарч ирнэ.")
    }
  }

  // MARK: - the doors

  @ViewBuilder private var doors: some View {
    Section {
      VStack(spacing: 10) {
        SignInWithAppleButton(.signIn) { request in
          let nonce = Nonce.make()
          appleNonce = nonce
          request.requestedScopes = [.fullName, .email]
          request.nonce = Nonce.sha256(nonce)
        } onCompletion: { result in
          Task { await signInWithApple(result) }
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: 50)
        .clipShape(Capsule())
        .accessibilityIdentifier("signin.apple")

        if methods?.google == true {
          GoogleButton { Task { await signInWithGoogle() } }
            .accessibilityIdentifier("signin.google")
        }
      }
      .disabled(busy)
      .listRowInsets(EdgeInsets())
      .listRowBackground(Color.clear)
    }

    if methods?.email == true {
      Section {
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
        if codeSentTo != nil {
          TextField("······", text: $emailCode)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .font(.mono(20, .semibold))
            .tracking(6)
            .focused($focus, equals: .emailCode)
            .onChange(of: emailCode) { _, typed in
              let digits = String(typed.filter(\.isNumber).prefix(6))
              if digits != typed { emailCode = digits }
              // Six digits is the whole code: pasted or typed, it goes
              // without another tap.
              if digits.count == 6 { Task { await checkEmailCode() } }
            }
            .accessibilityLabel("Имэйлд ирсэн код")
            .accessibilityIdentifier("signin.emailCode")
        }
      } header: {
        Text("Имэйлээр")
      } footer: {
        Text(emailFooter)
      }

      Section {
        WideButton(title: codeSentTo == nil ? "Код авах" : "Нэвтрэх", enabled: emailReady) {
          Task { if codeSentTo == nil { await askForCode() } else { await checkEmailCode() } }
        }
        .accessibilityIdentifier("signin.emailGo")
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
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
          .font(.sans(14))
          .buttonStyle(.borderless)
          .listRowBackground(Color.clear)
        }
      }
    }

    troubleSection

    Section {
      Button("Нууц үгээр нэвтрэх, бүртгүүлэх") { switchTo(.password) }
        .font(.sans(14))
        .accessibilityIdentifier("signin.passwordWay")
    } footer: {
      Text("Имэйл эсвэл утасны дугаар, нууц үгээр. Нууц үгээ мартсан, эсвэл Basu-аас урилгын код авсан бол мөн эндээс.")
    }
    .listRowBackground(Color.clear)

    developerDoor
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

  @ViewBuilder private var passwordDoors: some View {
    if door == .signIn || door == .signUp {
      Section {
        Picker("Нэвтрэх эсвэл бүртгүүлэх", selection: Binding(get: { door }, set: { open($0) })) {
          Text("Нэвтрэх").tag(Door.signIn)
          Text("Бүртгүүлэх").tag(Door.signUp)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .accessibilityIdentifier("signin.door")
      }
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets())
    }

    Section {
      if door == .invite {
        TextField("Урилгын код", text: $code)
          .keyboardType(.numberPad)
          .textContentType(.oneTimeCode)
          .font(.mono(16))
          .focused($focus, equals: .code)
          .accessibilityIdentifier("signin.invite")
        phoneField
      } else if door == .signUp && !byEmail {
        phoneField
      } else {
        if door == .signUp { nameField }
        loginField
        if lettered { letterCodeField }
      }
      // A reset's new password is asked for once the code is on its way —
      // before that there is nothing to set it with.
      if door != .forgot || lettered { passwordFields }
    } header: {
      Text(header)
    } footer: {
      Text(footer)
    }

    troubleSection

    Section {
      WideButton(title: action, enabled: ready) {
        Task { await go() }
      }
      .accessibilityIdentifier("signin.go")
      .listRowInsets(EdgeInsets())
      .listRowBackground(Color.clear)
      // No line between the button and the link under it: drawn, it reads
      // as the button's underside, and the two are one thing.
      .listRowSeparator(.hidden)
      if door == .signIn && byEmail {
        Button("Нууц үгээ мартсан?") { open(.forgot) }
          .font(.sans(14))
          .buttonStyle(.borderless)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .accessibilityIdentifier("signin.forgot")
      } else if lettered {
        Button("Код дахин авах") { Task { await askForLetter() } }
          .font(.sans(14))
          .buttonStyle(.borderless)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .accessibilityIdentifier("signin.resendLetter")
      }
    }

    Section {
      switch door {
      case .invite:
        Button("Кодгүй бол энгийнээр нэвтрэх") { open(.signIn) }
          .font(.sans(14))
          .accessibilityIdentifier("signin.inviteToggle")
      case .forgot:
        Button("Нэвтрэх рүү буцах") { open(.signIn) }
          .font(.sans(14))
          .accessibilityIdentifier("signin.back")
      case .signIn, .signUp:
        Button("Basu-аас урилгын код авсан уу?") { open(.invite) }
          .font(.sans(14))
          .accessibilityIdentifier("signin.inviteToggle")
      }
      if methods.map({ $0.apple || $0.google || $0.email }) ?? false {
        Button("Apple, Google эсвэл имэйлээр нэвтрэх") { switchTo(.doors) }
          .font(.sans(14))
          .accessibilityIdentifier("signin.doorsWay")
      }
    }
    .listRowBackground(Color.clear)

    developerDoor
  }

  private var nameField: some View {
    TextField("Нэр", text: $name)
      .textContentType(.name)
      .focused($focus, equals: .name)
      .submitLabel(.next)
      .onSubmit { focus = .login }
      .accessibilityIdentifier("signin.name")
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

  private var phoneField: some View {
    TextField("Утасны дугаар · 8811 2233", text: $phone)
      .keyboardType(.phonePad)
      .textContentType(.telephoneNumber)
      .font(.mono(16))
      .focused($focus, equals: .phone)
      .accessibilityIdentifier("signin.phone")
  }

  private var letterCodeField: some View {
    TextField("······", text: $letterCode)
      .keyboardType(.numberPad)
      .textContentType(.oneTimeCode)
      .font(.mono(20, .semibold))
      .tracking(6)
      .focused($focus, equals: .letterCode)
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
      .accessibilityLabel("Имэйлд ирсэн код")
      .accessibilityIdentifier(door == .forgot ? "signin.resetCode" : "signin.signUpCode")
  }

  @ViewBuilder private var passwordFields: some View {
    HStack(spacing: 10) {
      PasswordField(
        title: door == .signIn ? "Нууц үг" : "Шинэ нууц үг · дор хаяж 8 тэмдэгт",
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
    if door != .signIn {
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

  @ViewBuilder private var troubleSection: some View {
    if let trouble {
      Section {
        Banner(message: trouble)
          .accessibilityIdentifier("signin.trouble")
        if offerSignUp {
          Button("Шинэ хэрэглэгч бол бүртгүүлэх") { open(.signUp) }
            .font(.sans(14, .semibold))
            .accessibilityIdentifier("signin.offerSignUp")
        }
      }
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets())
    }
  }

  @ViewBuilder private var developerDoor: some View {
    #if DEBUG
      if Endpoint.base != Endpoint.pilot {
        Section {
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
          .font(.sans(14))
          .accessibilityIdentifier("signin.demo")
        } footer: {
          Text("Зөвхөн debug build, зөвхөн хөгжүүлэгчийн өөрийн сервер дээр.")
        }
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
    case .invite: return "Урилгаар нэвтрэх"
    }
  }

  private var header: String {
    switch door {
    case .signIn: "Имэйл эсвэл утас, нууц үг"
    case .signUp: "Шинэ бүртгэл"
    case .forgot: "Нууц үг сэргээх"
    case .invite: "Урилгын код"
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
    case .invite:
      return "Basu-аас авсан кодоо, өөрийн дугаар, шинэ нууц үгээ оруулна. Код нэг удаа хүчинтэй."
    }
  }

  private var action: String {
    switch door {
    case .signIn: "Нэвтрэх"
    case .signUp: byEmail && !lettered ? "Код авах" : "Бүртгүүлэх"
    case .forgot: lettered ? "Нууц үгээ шинэчлэх" : "Код авах"
    case .invite: "Нууц үгээ тавиад нэвтрэх"
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
    case .invite:
      return PhoneNumber.looksComplete(phone) && passwords && code.filter(\.isNumber).count >= 10
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
      case .invite: try await session.claim(code: code, phone: phone, password: password)
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
/// (on the dark ground, on the dark surface), a hairline, the words.
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
      .frame(height: 50)
      .background(Color.surface, in: Capsule())
      .overlay(Capsule().stroke(Color.line2, lineWidth: 1))
    }
    .buttonStyle(.plain)
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
