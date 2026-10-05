import BasuKit
import SwiftUI
import UserNotifications
import WebKit

/**
 The profile: who you are, who may open Basu on this phone, and what Basu is
 allowed to send you.

 There is no light-or-dark choice any more: Basu is dark on every screen
 whatever the phone's own setting («Тансаг хар», 2026-10-05).

 Short on purpose. A profile that grows a field per product stops being one
 person and becomes four apps sharing a form — table preference here, drop-off
 address there. Anything only one app cares about belongs to that app.

 Every switch here does what it says, today. The language row came off for
 that reason: the app speaks Mongolian only, and a choice of English that
 changed nothing was a setting in name only. The SMS row goes the same way on
 a server with no SMS gateway — the pilot has none yet — and comes back by
 itself when it has one.

 What cannot be undone is asked in an alert, which always draws «Болих»: a
 confirmation dialog on iOS 26 is a popover whose only button was the
 irreversible one.
 */
struct ProfileView: View {
  @Environment(Platform.self) private var platform
  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model
  @Environment(AppLock.self) private var lock
  @Environment(\.scenePhase) private var phase

  @State private var editing: Field?
  @State private var closing = false
  /// The server's no to closing, in its own words: money still in the
  /// wallet, an order still running.
  @State private var closeRefusal: String?
  @State private var signingOutOthers = false
  /// What iOS itself says about notifications, apart from Basu's own switches.
  @State private var permission: UNAuthorizationStatus?
  @State private var cacheCleared = false
  /// What the last password change did, said under the card it was made from.
  @State private var passwordNote: String?
  /// The ways the server can reach somebody: no gateway, no SMS switch.
  @State private var methods: AuthMethods?

  enum Field: String, Identifiable {
    /// The address sheet opened from the password row: an account with no
    /// address adds one first, and the sheet says that is why.
    case name, email, emailFirst, password
    var id: String { rawValue }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        if session.isSignedIn {
          VStack(alignment: .leading, spacing: 16) {
            identity
            // Said where it is seen on arrival, not at the foot of the page
            // under the tab bar.
            if let trouble = platform.trouble {
              Banner(message: trouble)
                .accessibilityIdentifier("profile.trouble")
            }
          }
          fields
          settings
          notifications
          DevicesSection(confirmingOthers: $signingOutOthers)
          help
          signOut
          closeAccount
        } else {
          // Looking around (see `RootView`): the way in, and what is this
          // phone's rather than the account's — the help.
          SignInPrompt(
            symbol: "person.crop.circle",
            title: "Нэвтэрч захиалаарай",
            detail: "Apple, Google эсвэл имэйлээр нэг алхамд.",
            id: "profile.signin",
          )
          .padding(.top, 8)
          help
        }
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.top, 4)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(Color.bg)
    .safeAreaInset(edge: .top, spacing: 0) { ShellTitle("Профайл") }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .sheet(item: $editing) { field in
      switch field {
      case .name: ProfileEditSheet()
      case .email: EmailAttachSheet()
      case .emailFirst: EmailAttachSheet(forPassword: true)
      case .password: PasswordChangeSheet { revoked, first in noteChanged(revoked: revoked, first: first) }
      }
    }
    .alert("Бусад бүх төхөөрөмжөөс гарах уу?", isPresented: $signingOutOthers) {
      Button("Гаргах", role: .destructive) {
        Task { await platform.signOutOtherDevices() }
      }
      Button("Болих", role: .cancel) {}
    } message: {
      Text("Энэ утас нэвтэрсэн хэвээр үлдэнэ.")
    }
    .alert(
      "Бүртгэлийг хааж чадсангүй",
      isPresented: Binding(get: { closeRefusal != nil }, set: { if !$0 { closeRefusal = nil } }),
    ) {
      Button("Ойлголоо", role: .cancel) {}
    } message: {
      Text(closeRefusal ?? "")
    }
    .task {
      await platform.refresh()
      await platform.loadPreferences()
      await platform.loadSessions()
    }
    .task(id: session.token) {
      methods = await session.methods()
    }
    // Back from the phone's Settings, where the answer may have changed.
    .task(id: phase) {
      guard phase == .active else { return }
      permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
  }

  // MARK: - who

  private var identity: some View {
    HStack(spacing: 16) {
      SeedAvatar(seed: platform.me?.avatarSeed ?? "00000000", size: BasuMetric.avatarProfile)
      VStack(alignment: .leading, spacing: 6) {
        headline
        // Figures tabular, so a number reads in its groups.
        if let phone = platform.me?.phone ?? (platform.me == nil ? session.phone : nil) {
          Text(spaced(phone))
            .font(.sans(15, .semibold))
            .monospacedDigit()
            .foregroundStyle(Color.ink2)
        } else if let email = platform.me?.email ?? session.email {
          Text(email)
            .font(.sans(15, .semibold))
            .foregroundStyle(Color.ink2)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if let me = platform.me {
          Text("Basu-д \(Format.since(me.memberSince)) хойш")
            .font(.sans(13, .medium))
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  /**
   The name — or, for an account that has none yet, the way to give one,
   where the name goes. Every new account used to be headed «Нэргүй» in 24
   points, which reads as a fault rather than a field nobody has filled.
   */
  @ViewBuilder private var headline: some View {
    if let name = platform.me?.displayName?.trimmingCharacters(in: .whitespaces), !name.isEmpty {
      Text(name)
        .font(.display(29))
        .foregroundStyle(Color.ink)
        .fixedSize(horizontal: false, vertical: true)
    } else if platform.me != nil {
      Button { editing = .name } label: {
        HStack(spacing: 8) {
          Text("Нэрээ оруулах")
            .font(.display(29))
          Chevron(size: 14, lineWidth: 2.2)
            .foregroundStyle(Color.ink3)
        }
        .foregroundStyle(Color.ink)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("profile.addName")
    } else {
      // Still on its way: the shape of a name, not a word that is wrong.
      Text("Батаа Болд")
        .font(.display(29))
        .redacted(reason: .placeholder)
        .accessibilityHidden(true)
    }
  }

  /// `+97699001122` → `+976 9900 1122`. A phone number is read in groups.
  private func spaced(_ phone: String) -> String {
    guard phone.hasPrefix("+976"), phone.count == 12 else { return phone }
    let digits = phone.dropFirst(4)
    return "+976 \(digits.prefix(4)) \(digits.suffix(4))"
  }

  // MARK: - what

  private var fields: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Бүртгэл")
      VStack(spacing: 0) {
        Button { editing = .name } label: {
          HStack(spacing: 12) {
            RowLabel(title: "Нэр", symbol: "person")
            Spacer(minLength: 8)
            Text(platform.me?.displayName ?? "—")
              .font(.sans(15, .medium))
              .foregroundStyle(platform.me?.displayName == nil ? Color.ink3 : Color.ink)
              .lineLimit(1)
              // The row's own word keeps its width; the name gives way.
              .minimumScaleFactor(0.6)
              .layoutPriority(-1)
            Chevron(size: 13).foregroundStyle(Color.ink3)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 14)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("profile.name")

        // A server that does not say whether there is a password has neither
        // the changing of one nor the address to get one back with: rather
        // than two rows that fail when tapped, none.
        if let me = platform.me, let hasPassword = me.hasPassword {
          Hairline()
          emailRow(me)
          Hairline()
          passwordRow(hasPassword: hasPassword, hasEmail: me.email != nil)
        }
      }
      .card()

      if let passwordNote {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Image(systemName: "checkmark")
            .font(.sans(11, .semibold))
            .foregroundStyle(Color.ready)
          Text(passwordNote)
            .font(.sans(12))
            .lineSpacing(12 * 0.55 - 3)
            .foregroundStyle(Color.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("profile.password.note")
      }
    }
    .sensoryFeedback(.success, trigger: passwordNote) { _, now in now != nil }
  }

  /**
   The address on the account, or the way to add one.

   Without one, a forgotten password is a locked door: there is no SMS, and
   the code that replaces a password goes to an inbox. The row says so, since
   nobody adds an address for its own sake.
   */
  @ViewBuilder private func emailRow(_ me: Me) -> some View {
    if let email = me.email {
      HStack(spacing: 12) {
        RowLabel(title: "Имэйл", symbol: "at")
        Spacer(minLength: 8)
        Text(email)
          .font(.sans(15, .medium))
          .foregroundStyle(Color.ink)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("profile.email")
    } else {
      Button { editing = .email } label: {
        HStack(spacing: 12) {
          RowLabel(title: "Имэйл холбох", symbol: "at", detail: "Нууц үгээ мартвал энэ хаягаар сэргээнэ")
          Spacer(minLength: 8)
          Chevron(size: 13).foregroundStyle(Color.ink3)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("profile.email")
    }
  }

  /**
   The password: changed, or set for the first time. A first password is set
   with a code sent to the address on the account, so an account with no
   address adds one first — the row says so, and opens that sheet instead,
   which says it again at its top.
   */
  private func passwordRow(hasPassword: Bool, hasEmail: Bool) -> some View {
    let needsAddress = !hasPassword && !hasEmail
    return Button { editing = needsAddress ? .emailFirst : .password } label: {
      HStack(spacing: 12) {
        RowLabel(
          title: hasPassword ? "Нууц үг солих" : "Нууц үг тохируулах",
          symbol: "key",
          detail: hasPassword
            ? nil
            : needsAddress
              ? "Эхлээд имэйлээ холбоно уу — тохируулах код тэр хаяг руу очно"
              : "Имэйл эсвэл утас, нууц үгээр нэвтрэхийн тулд",
        )
        Spacer(minLength: 8)
        Chevron(size: 13).foregroundStyle(Color.ink3)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("profile.password")
  }

  /// Every other device is signed out by a new password; saying how many is
  /// what tells somebody who changed it after a lost phone that it worked.
  private func noteChanged(revoked: Int, first: Bool) {
    let done = first ? "Нууц үг тохирууллаа." : "Нууц үг солигдлоо."
    passwordNote = revoked > 0 ? "\(done) Бусад \(revoked) төхөөрөмжөөс гаргалаа." : done
  }

  // MARK: - this phone

  /// How Basu looks and who may open it — both about this phone, not the
  /// account, and kept on it.
  /// Who may open Basu on this phone — about this phone, not the account,
  /// and kept on it. (How Basu looks is no longer a choice: it is dark.)
  private var settings: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionLabel("Тохиргоо")
      lockRow
        .card()

      Text(lockFooter)
        .font(.sans(13, .medium))
        .foregroundStyle(Color.ink3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder private var lockRow: some View {
    let kind = lock.kind
    if kind == .none {
      RowLabel(title: "Апп түгжих", symbol: "lock", detail: "Утсандаа нууц код тавьсны дараа асаана")
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .opacity(0.6)
        .accessibilityIdentifier("settings.lock")
    } else {
      switchRow(
        "\(kind.by) түгжих",
        symbol: kind.symbol,
        detail: "Нээх бүрд таныг мөн эсэхийг шалгана",
        isOn: lock.enabled,
        id: "settings.lock",
      ) { await lock.turn(on: $0) }
    }
  }

  private var lockFooter: String {
    let minutes = Int(AppLock.grace / 60)
    return "Түгжээтэй үед \(minutes) минутаас удаан гарвал \(lock.kind.by) нээнэ."
  }

  // MARK: - what we may send

  private var notifications: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Мэдэгдэл")
      VStack(spacing: 0) {
        if let permission, permission == .denied || permission == .notDetermined {
          permissionRow(permission)
          Hairline()
        }
        switchRow(
          "Апп-аар",
          symbol: "bell",
          detail: "Захиалга, түрийвчийн мэдээ шууд утсанд",
          isOn: platform.preferences.push,
          id: "profile.pref.push",
        ) { await platform.setPreference(push: $0) }
        // Only where SMS can actually be sent. A switch that is on and does
        // nothing is the one kind this screen does not have.
        if methods?.sms == true {
          Hairline()
          switchRow(
            "SMS-ээр",
            symbol: "message",
            detail: "Апп-аар хүрэхгүй үед мессежээр",
            isOn: platform.preferences.sms,
            id: "profile.pref.sms",
          ) { await platform.setPreference(sms: $0) }
        }
        Hairline()
        switchRow(
          "Урамшуулал",
          symbol: "gift",
          detail: "Шинэ үйлчилгээ, хямдралын тухай",
          isOn: platform.preferences.marketing,
          id: "profile.pref.marketing",
        ) { await platform.setPreference(marketing: $0) }
      }
      .card()

      // Being honest about what cannot be switched off is the difference
      // between a setting and a lie.
      Text("Захиалгын явцын мэдэгдэл үргэлж ирнэ.")
        .font(.sans(13, .medium))
        .foregroundStyle(Color.ink3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /**
   The phone's own answer comes before Basu's switches: with notifications
   refused in iOS, «Апп-аар» on changes nothing, and saying so is kinder than
   a switch that silently does not work.
   */
  private func permissionRow(_ status: UNAuthorizationStatus) -> some View {
    HStack(spacing: 12) {
      RowLabel(
        title: status == .denied ? "Утасны тохиргоонд хаалттай" : "Зөвшөөрөл өгөөгүй",
        symbol: "bell.slash",
        detail: "Мэдэгдэл утсанд ирэхгүй байна",
        tint: .hold,
      )
      Spacer(minLength: 8)
      Button(status == .denied ? "Нээх" : "Зөвшөөрөх") {
        Task {
          if status == .denied {
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
              await UIApplication.shared.open(url)
            }
          } else {
            await PushRegistrar.shared.askIfNeeded()
            permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
          }
        }
      }
      .font(.sans(14, .bold))
      .foregroundStyle(Color.onLight)
      .padding(.horizontal, 16)
      .frame(minHeight: 36)
      .background(Color.ink, in: Capsule())
      .frame(minHeight: BasuMetric.minTarget)
      .accessibilityIdentifier("profile.permission")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
    .background(Color.surface2)
  }

  private func switchRow(
    _ name: String,
    symbol: String,
    detail: String? = nil,
    isOn: Bool,
    id: String,
    set: @escaping (Bool) async -> Void,
  ) -> some View {
    Button {
      Task { await set(!isOn) }
    } label: {
      HStack(spacing: 14) {
        RowLabel(title: name, symbol: symbol, detail: detail)
        Spacer(minLength: 8)
        Switch(isOn: isOn)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 13)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
    .accessibilityHint(detail ?? "")
    .accessibilityValue(isOn ? "асаалттай" : "унтраалттай")
    .accessibilityAddTraits([.isToggle, .isButton])
    .accessibilityIdentifier(id)
    .sensoryFeedback(.selection, trigger: isOn)
  }

  // MARK: - the footer everything else lives in

  /// The terms and the privacy policy are the pages the server serves
  /// itself — the same ones the web links to — so they open wherever the app
  /// is talking to.
  private var help: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Тусламж")
      VStack(spacing: 0) {
        link("Холбоо барих", symbol: "envelope", URL(string: "mailto:basuappmn@gmail.com")!)
        Hairline()
        link("Үйлчилгээний нөхцөл", symbol: "doc.text", Endpoint.base.appending(path: "terms"))
        Hairline()
        link("Нууцлалын бодлого", symbol: "hand.raised", Endpoint.base.appending(path: "privacy"))
        Hairline()
        clearCache
      }
      .card()

      // The version, because the first thing anybody is asked when they report
      // something is which build they are on, and nobody knows.
      Text("Basu \(Self.version)")
        .font(.sans(12, .semibold))
        .monospacedDigit()
        .foregroundStyle(Color.ink3)
        .textSelection(.enabled)
    }
  }

  private static var version: String {
    let info = Bundle.main.infoDictionary
    let short = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(short) (\(build))"
  }

  private func link(_ title: String, symbol: String, _ url: URL) -> some View {
    Link(destination: url) {
      HStack(spacing: 12) {
        RowLabel(title: title, symbol: symbol)
        Spacer(minLength: 8)
        Chevron(size: 13).foregroundStyle(Color.ink3)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .contentShape(Rectangle())
    }
  }

  /**
   The apps inside Basu are web pages, and a page kept from last week can show
   last week's picture. This throws the kept copies away — only copies: nobody
   is signed out, and nothing of theirs is lost.
   */
  private var clearCache: some View {
    Button {
      Task {
        let kept: Set<String> = [
          WKWebsiteDataTypeDiskCache,
          WKWebsiteDataTypeMemoryCache,
          WKWebsiteDataTypeFetchCache,
        ]
        await WKWebsiteDataStore.default().removeData(ofTypes: kept, modifiedSince: .distantPast)
        URLCache.shared.removeAllCachedResponses()
        cacheCleared = true
        try? await Task.sleep(for: .seconds(3))
        cacheCleared = false
      }
    } label: {
      HStack(spacing: 12) {
        RowLabel(
          title: "Кэш цэвэрлэх",
          symbol: "arrow.clockwise",
          detail: cacheCleared ? "Цэвэрлэлээ" : "Хуудас хуучин эсвэл буруу харагдвал",
        )
        Spacer(minLength: 8)
        if cacheCleared {
          Image(systemName: "checkmark")
            .font(.sans(14, .semibold))
            .foregroundStyle(Color.ready)
            .transition(.opacity)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .contentShape(Rectangle())
      .animation(.easeOut(duration: 0.2), value: cacheCleared)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("settings.cache")
    .sensoryFeedback(.success, trigger: cacheCleared) { _, now in now }
  }

  private var signOut: some View {
    Button {
      platform.signOut()
      Task {
        await model.refreshLive()
        await platform.refresh()
      }
    } label: {
      // Reversible, so not crimson: an outlined capsule, the way out.
      Text("Гарах")
        .font(.sans(16, .bold))
        .foregroundStyle(Color.ink)
        .frame(maxWidth: .infinity)
        .frame(minHeight: BasuMetric.buttonHeight)
        .overlay(Capsule().strokeBorder(Color.line2, lineWidth: BasuMetric.hairline))
        .contentShape(Capsule())
    }
    .buttonStyle(Pressable())
    .accessibilityIdentifier("profile.signout")
  }

  /**
   Leaving, for good.

   Required by App Store review guideline 5.1.1(v): an app that makes accounts
   has to let somebody close theirs from inside it — not by email, not by
   ringing anybody. Set apart from «Гарах» and worded so the two cannot be
   confused, because one of them is reversible and the other is not; and the
   button that does it says «устгах», never «Хаах», which everywhere else in
   the app is the word that closes a sheet.

   A refusal — money still in the wallet, an order still running — comes back
   as an alert of its own: a banner here sat under the tab bar, out of sight.
   */
  private var closeAccount: some View {
    Button { closing = true } label: {
      // Crimson words and nothing else: the alert asks before anything goes.
      Text("Бүртгэл хаах")
        .font(.sans(14, .semibold))
        .foregroundStyle(Color.accentInk)
        .padding(.horizontal, 12)
        .frame(minHeight: BasuMetric.minTarget)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("profile.close")
    .frame(maxWidth: .infinity, alignment: .center)
    .alert("Бүртгэлээ бүрмөсөн хаах уу?", isPresented: $closing) {
      Button("Бүртгэлээ устгах", role: .destructive) {
        Task { closeRefusal = await platform.closeAccount() }
      }
      Button("Болих", role: .cancel) {}
    } message: {
      Text("Нэр, утас, мэдэгдэл устана. Хийсэн гүйлгээ, татварын баримт хуулийн дагуу үлдэнэ. Буцаах боломжгүй.")
    }
  }
}

/// A row's leading half: the mark, the name, and a line under it when the
/// name alone would leave somebody guessing what the row does.
struct RowLabel: View {
  let title: String
  let symbol: String
  var detail: String?
  var tint: Color = .ink2

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: symbol)
        .font(.sans(17, .medium))
        .foregroundStyle(tint)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .frame(minWidth: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.sans(16, .semibold))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        if let detail {
          Text(detail)
            .font(.sans(13, .medium))
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

/**
 The switch, to the design's metrics: a 51 × 31 track at radius 16 — the ink
 when on, with a charcoal knob; `surface3` when off, with a knob in `ink3`.
 No green: on is the brightest thing on the row, which is all on has to be.

 Drawn rather than borrowed because the system toggle is green. The row it
 sits in is the control — the whole row toggles, and is the switch to
 VoiceOver.
 */
struct Switch: View {
  let isOn: Bool

  var body: some View {
    ZStack(alignment: isOn ? .trailing : .leading) {
      RoundedRectangle(cornerRadius: BasuMetric.switchTrack, style: .continuous)
        .fill(isOn ? Color.ink : Color.surface3)
        .overlay(
          RoundedRectangle(cornerRadius: BasuMetric.switchTrack, style: .continuous)
            .strokeBorder(isOn ? Color.clear : Color.line2, lineWidth: BasuMetric.hairline),
        )
      Circle()
        .fill(isOn ? Color.onLight : Color.ink3)
        .frame(width: 27, height: 27)
        .shadow(color: .black.opacity(0.3), radius: 1.5, y: 1)
        .padding(2)
    }
    .frame(width: BasuMetric.switchSize.width, height: BasuMetric.switchSize.height)
    .animation(.easeOut(duration: 0.18), value: isOn)
    .accessibilityHidden(true)
  }
}

/**
 A sheet of the profile's: the ground, the title in the bar with «Болих»
 beside it, and the form on one card made of the way in's own parts — so
 adding an address looks like the app that signed you in, not a settings
 screen from another one.
 */
struct ProfileSheet<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        content
          .padding(.horizontal, BasuMetric.screenPadding)
          .padding(.top, 8)
          .padding(.bottom, 28)
          .frame(maxWidth: 460)
          .frame(maxWidth: .infinity)
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .containerBackground(for: .navigation) { Color.surface2.ignoresSafeArea() }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Болих") { dismiss() }
        }
      }
    }
  }
}

/**
 The one field being changed, on its own.

 A row that turns into a text field in place is a row that moves under the
 thumb and loses what was typed on the next refresh. A sheet has a button
 that says what it does, which is what «I have finished» looks like.
 */
struct ProfileEditSheet: View {
  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var busy = false
  @State private var trouble: String?
  @FocusState private var typing: Bool

  private var ready: Bool { !busy && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  var body: some View {
    ProfileSheet(title: "Нэр") {
      VStack(spacing: 12) {
        AuthField(symbol: "person", active: typing) { typing = true } content: {
          TextField("Таныг юу гэж дуудах вэ?", text: $name, prompt: placeholder("Таныг юу гэж дуудах вэ?"))
            .textContentType(.name)
            .focused($typing)
            .submitLabel(.done)
            .onSubmit { save() }
            .accessibilityIdentifier("profile.name.field")
        }
        if let trouble {
          TroubleNote(text: trouble, id: "profile.name.trouble")
        }
        Note(text: "Захиалга дээр энэ нэр харагдана — ресторан, нийлүүлэгч таныг ингэж танина.")
        PrimaryButton(title: "Хадгалах", enabled: ready, busy: busy) { save() }
          .accessibilityIdentifier("profile.name.save")
      }
    }
    .presentationDetents([.medium, .large])
    .sensoryFeedback(.error, trigger: trouble) { _, said in said != nil }
    .task {
      name = platform.me?.displayName ?? ""
    }
  }

  private func save() {
    guard ready else { return }
    Task {
      busy = true
      trouble = nil
      defer { busy = false }
      if await platform.save(displayName: name.trimmingCharacters(in: .whitespacesAndNewlines), locale: nil) {
        dismiss()
      } else {
        trouble = platform.trouble ?? "Хадгалж чадсангүй. Дахин оролдоно уу."
      }
    }
  }
}

/**
 An address, for an account that has none: the way back when a password is
 forgotten, since the code that replaces one goes to an inbox.

 A code goes to the address first, so an address is never somebody else's.
 An account with a password types it too — a session can be stolen, and a
 stolen one must not be able to give itself a way back in. One without a
 password has nothing to type: the server asks it to have signed in a moment
 ago, and says so in its refusal when it has not.
 */
struct EmailAttachSheet: View {
  /// Opened from «Нууц үг тохируулах»: the address comes before the password,
  /// and the sheet says so rather than leaving somebody wondering why they
  /// asked for one thing and got another.
  var forPassword = false

  fileprivate enum Field: Hashable { case email, password, passwordShown, code }

  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var email = ""
  @State private var password = ""
  @State private var reveal = false
  @State private var code = ""
  /// The address the code went to. Typing another starts over.
  @State private var sentTo: String?
  @State private var busy = false
  @State private var trouble: String?
  @FocusState private var focus: Field?

  private var needsPassword: Bool { platform.me?.hasPassword == true }

  var body: some View {
    ProfileSheet(title: "Имэйл холбох") {
      VStack(spacing: 16) {
        if forPassword {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "key")
              .font(.sans(15, .medium))
              .foregroundStyle(Color.gold)
              .accessibilityHidden(true)
            Text("Нууц үг тохируулахын өмнө имэйлээ холбоно уу — тохируулах код тэр хаяг руу очно.")
              .font(.sans(14))
              .foregroundStyle(Color.ink)
              .fixedSize(horizontal: false, vertical: true)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .background(Color.surface, in: RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous))
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("profile.email.why")
        }

        VStack(spacing: 12) {
          AuthField(symbol: "envelope", active: focus == .email) { focus = .email } content: {
            TextField("Имэйл хаяг", text: $email, prompt: placeholder("Имэйл хаяг"))
              .keyboardType(.emailAddress)
              .textContentType(.emailAddress)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .focused($focus, equals: .email)
              .submitLabel(needsPassword ? .next : .send)
              .onSubmit {
                if needsPassword { focus = reveal ? .passwordShown : .password } else { Task { await send() } }
              }
              .onChange(of: email) { _, typed in
                // Another address after a code went out is a new start, not a
                // code for the old one.
                if let sent = sentTo, Session.address(typed) != sent {
                  sentTo = nil
                  code = ""
                }
              }
              .accessibilityIdentifier("profile.email.field")
          }

          if needsPassword {
            AuthField(symbol: "lock", active: focus == .password || focus == .passwordShown) {
              focus = reveal ? .passwordShown : .password
            } content: {
              HStack(spacing: 8) {
                PasswordField(
                  title: "Одоогийн нууц үг",
                  text: $password,
                  reveal: reveal,
                  content: .password,
                  focus: $focus,
                  hidden: .password,
                  shown: .passwordShown,
                )
                .submitLabel(.send)
                .onSubmit { Task { await send() } }
                .accessibilityIdentifier("profile.email.password")
                RevealButton(reveal: $reveal, focus: $focus, twins: [(.password, .passwordShown)])
              }
            }
          }

          if sentTo != nil {
            CodeInput(code: $code, focus: $focus, field: .code, id: "profile.email.code")
              .onChange(of: code) { _, typed in
                let digits = String(typed.filter(\.isNumber).prefix(6))
                if digits != typed {
                  code = digits
                  return
                }
                // Six digits is the whole code: it goes without another tap.
                if digits.count == 6 { Task { await confirm() } }
              }
              .transition(.move(edge: .top).combined(with: .opacity))
          }

          if let trouble {
            TroubleNote(text: trouble, id: "profile.email.trouble")
          }

          Note(text: footer)

          PrimaryButton(title: sentTo == nil ? "Код авах" : "Холбох", enabled: ready, busy: busy) {
            Task { if sentTo == nil { await send() } else { await confirm() } }
          }
          .accessibilityIdentifier("profile.email.go")

          if sentTo != nil {
            QuietLink("Код дахин авах") { Task { await send() } }
              .padding(.vertical, -8)
          }
        }
      }
      .animation(.snappy(duration: 0.28), value: sentTo)
      .animation(.easeOut(duration: 0.2), value: trouble)
    }
    .presentationDetents([.large])
    .sensoryFeedback(.error, trigger: trouble) { _, said in said != nil }
  }

  private var footer: String {
    if let sentTo {
      return "\(sentTo) хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай."
    }
    let why = "Нууц үгээ мартвал энэ хаяг руу код ирж, шинэ нууц үг тавина. Хаяг таных гэдгийг батлах 6 оронтой код илгээнэ."
    return needsPassword ? why + " Бүртгэл таных гэдгийг нууц үгээр баталгаажуулна." : why
  }

  private var ready: Bool {
    guard !busy else { return false }
    if sentTo != nil { return code.count == 6 }
    return Session.address(email).contains("@") && (!needsPassword || !password.isEmpty)
  }

  private func send() async {
    guard !busy, Session.address(email).contains("@"), !needsPassword || !password.isEmpty else { return }
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      try await platform.requestEmailCode(email, password: needsPassword ? password : nil)
      sentTo = Session.address(email)
      code = ""
      focus = .code
    } catch let error as APIError {
      trouble = error.message
      if error.code == "WRONG_PASSWORD" { focus = reveal ? .passwordShown : .password }
    } catch {
      trouble = "Код илгээж чадсангүй. Дахин оролдоно уу."
    }
  }

  private func confirm() async {
    guard !busy, let sent = sentTo, code.count == 6 else { return }
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      try await platform.attachEmail(sent, code: code)
      dismiss()
    } catch let error as APIError {
      trouble = error.message
      code = ""
      focus = .code
    } catch {
      trouble = "Холбож чадсангүй. Дахин оролдоно уу."
    }
  }
}

/**
 A password: changed knowing the old one, or chosen for the first time by an
 account made by email, Google or Apple, which has none to know.

 The first is never set on this phone's word alone. A session is only
 something somebody holds, and one left signed in somewhere would give its
 holder a password of their own and sign the owner out everywhere with it.
 So it is two steps, like the address sheet: a code to the address on the
 account — the server sends it nowhere else — then the code and the new
 password.

 Every other session ends — whoever knew the old password is out — and this
 phone stays signed in. The profile says how many went (`changed`).
 */
struct PasswordChangeSheet: View {
  /// How many other devices were signed out, and whether it was the first.
  let changed: (_ revoked: Int, _ first: Bool) -> Void

  fileprivate enum Field: Hashable { case current, currentShown, code, next, nextShown, again, againShown }

  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var current = ""
  @State private var code = ""
  @State private var next = ""
  @State private var again = ""
  /// Where the first password's code went. Until it has gone there is
  /// nothing to set a first password with.
  @State private var sentTo: String?
  @State private var reveal = false
  @State private var busy = false
  @State private var trouble: String?
  @FocusState private var focus: Field?

  private var hasPassword: Bool { platform.me?.hasPassword == true }
  /// A first password whose code has not gone yet.
  private var waiting: Bool { !hasPassword && sentTo == nil }
  private var title: String { hasPassword ? "Нууц үг солих" : "Нууц үг тохируулах" }

  var body: some View {
    ProfileSheet(title: title) {
      VStack(spacing: 12) {
        if hasPassword {
          // The eye sits on the first password, whichever that is, and shows all three.
          AuthField(symbol: "lock", active: focus == .current || focus == .currentShown) {
            focus = reveal ? .currentShown : .current
          } content: {
            HStack(spacing: 8) {
              PasswordField(
                title: "Одоогийн нууц үг",
                text: $current,
                reveal: reveal,
                content: .password,
                focus: $focus,
                hidden: .current,
                shown: .currentShown,
              )
              .submitLabel(.next)
              .onSubmit { focus = reveal ? .nextShown : .next }
              .accessibilityIdentifier("profile.password.current")
              eye
            }
          }
          nextField(withEye: false)
          againField
        } else if sentTo != nil {
          codeField
          nextField(withEye: true)
          againField
        } else {
          // Nothing to type yet: the code goes to the address on the account.
          AuthValue(symbol: "envelope", label: "Код очих хаяг", value: platform.me?.email ?? "—")
            .accessibilityIdentifier("profile.password.to")
        }

        if let trouble {
          TroubleNote(text: trouble, id: "profile.password.trouble")
        }

        Note(text: footer)

        PrimaryButton(title: waiting ? "Код авах" : title, enabled: ready, busy: busy) {
          Task { if waiting { await send() } else { await save() } }
        }
        .accessibilityIdentifier("profile.password.go")

        if !hasPassword, sentTo != nil {
          QuietLink("Код дахин авах") { Task { await send() } }
            .padding(.vertical, -8)
        }
      }
      .animation(.snappy(duration: 0.28), value: sentTo)
      .animation(.easeOut(duration: 0.2), value: trouble)
    }
    .presentationDetents([.large])
    .sensoryFeedback(.error, trigger: trouble) { _, said in said != nil }
  }

  private var codeField: some View {
    CodeInput(code: $code, focus: $focus, field: .code, id: "profile.password.code")
      .onChange(of: code) { _, typed in
        let digits = String(typed.filter(\.isNumber).prefix(6))
        if digits != typed {
          code = digits
          return
        }
        // Six digits is the whole code: the keyboard moves on to the password.
        if digits.count == 6, next.isEmpty { focus = reveal ? .nextShown : .next }
      }
  }

  private func nextField(withEye: Bool) -> some View {
    AuthField(symbol: "lock", active: focus == .next || focus == .nextShown) {
      focus = reveal ? .nextShown : .next
    } content: {
      HStack(spacing: 8) {
        PasswordField(
          title: "Шинэ нууц үг · 8+ тэмдэгт",
          text: $next,
          reveal: reveal,
          content: .newPassword,
          focus: $focus,
          hidden: .next,
          shown: .nextShown,
        )
        .submitLabel(.next)
        .onSubmit { focus = reveal ? .againShown : .again }
        .accessibilityIdentifier("profile.password.next")
        if withEye { eye }
      }
    }
  }

  private var againField: some View {
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
      .onSubmit { Task { await save() } }
      .accessibilityIdentifier("profile.password.again")
    }
  }

  private var eye: some View {
    RevealButton(
      reveal: $reveal,
      focus: $focus,
      twins: [(.current, .currentShown), (.next, .nextShown), (.again, .againShown)],
    )
    .accessibilityIdentifier("profile.password.reveal")
  }

  private var footer: String {
    let cyrillic = "Кирилл үсэгтэй нууц үгийг нүдэн тэмдгийг дараад бичнэ."
    if hasPassword {
      return "Солимогц бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ утас нэвтэрсэн хэвээр үлдэнэ. \(cyrillic)"
    }
    if let sentTo {
      return "\(sentTo) хаяг руу код илгээлээ. 10 минут хүчинтэй — ирэхгүй бол Spam хавтсаа шалгаарай. \(cyrillic)"
    }
    return "Таныг мөн гэдгийг батлах 6 оронтой код бүртгэлийн тань имэйл рүү очно. Дараа нь имэйл эсвэл утас, энэ нууц үгээрээ нэвтэрч болно."
  }

  private var ready: Bool {
    guard !busy else { return false }
    if waiting { return true }
    let passwords = !next.isEmpty && !again.isEmpty
    return hasPassword ? passwords && !current.isEmpty : passwords && code.count == 6
  }

  /// The first password's code, to the address on the account.
  private func send() async {
    guard !busy, !hasPassword else { return }
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      sentTo = try await platform.requestPasswordCode()
      code = ""
      focus = .code
    } catch let error as APIError {
      trouble = error.message
    } catch {
      trouble = "Код илгээж чадсангүй. Дахин оролдоно уу."
    }
  }

  private func save() async {
    guard ready, !waiting else { return }
    // Checked here rather than left to the server: a mistyped repeat is the
    // one mistake the person can see for themselves.
    if next.count < 8 {
      trouble = "Нууц үг дор хаяж 8 тэмдэгт байх ёстой."
      focus = reveal ? .nextShown : .next
      return
    }
    if next != again {
      trouble = "Хоёр нууц үг таарахгүй байна."
      focus = reveal ? .againShown : .again
      return
    }
    let first = !hasPassword
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      let revoked = try await platform.changePassword(
        current: first ? nil : current,
        next: next,
        code: first ? code : nil,
      )
      changed(revoked, first)
      dismiss()
    } catch let error as APIError {
      trouble = error.message
      if error.code == "WRONG_PASSWORD" {
        focus = reveal ? .currentShown : .current
      } else if ["INVALID_CODE", "EXPIRED", "RATE_LIMITED"].contains(error.code) {
        // A wrong, spent or stale code: the field empties for the next one.
        code = ""
        focus = .code
      }
    } catch {
      trouble = "Нууц үг сольж чадсангүй. Дахин оролдоно уу."
    }
  }
}
