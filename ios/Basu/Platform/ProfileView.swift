import BasuKit
import SwiftUI
import UserNotifications
import WebKit

/**
 The profile: who you are, how this phone shows Basu, and what Basu is
 allowed to send you.

 Short on purpose. A profile that grows a field per product stops being one
 person and becomes four apps sharing a form — table preference here, drop-off
 address there. Anything only one app cares about belongs to that app.

 Every switch here does what it says, today. The language row came off for
 that reason: the app speaks Mongolian only, and a choice of English that
 changed nothing was a setting in name only.
 */
struct ProfileView: View {
  @Environment(Platform.self) private var platform
  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model
  @Environment(AppLock.self) private var lock
  @Environment(\.scenePhase) private var phase
  @AppStorage(Appearance.key) private var appearance: Appearance = .system

  @State private var editing: Field?
  @State private var closing = false
  @State private var signingOutOthers = false
  /// What iOS itself says about notifications, apart from Basu's own switches.
  @State private var permission: UNAuthorizationStatus?
  @State private var cacheCleared = false
  /// What the last password change did, said under the card it was made from.
  @State private var passwordNote: String?

  enum Field: String, Identifiable {
    case name, email, password
    var id: String { rawValue }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        // Only ever drawn signed in: signing out, or closing the account,
        // swaps the whole shell for the way in (see `RootView`).
        identity
        fields
        settings
        notifications
        devices
        help
        signOut
        closeAccount
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, 78)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top, spacing: 0) { ShellTitle("Профайл") }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .sheet(item: $editing) { field in
      switch field {
      case .name: ProfileEditSheet(field: field)
      case .email: EmailAttachSheet()
      case .password: PasswordChangeSheet { revoked, first in noteChanged(revoked: revoked, first: first) }
      }
    }
    .confirmationDialog(
      "Бусад төхөөрөмжөөс гарах уу?",
      isPresented: $signingOutOthers,
      titleVisibility: .visible,
    ) {
      Button("Гаргах", role: .destructive) {
        Task { await platform.signOutOtherDevices() }
      }
      Button("Болих", role: .cancel) {}
    } message: {
      Text("Энэ утас нэвтэрсэн хэвээр үлдэнэ.")
    }
    .confirmationDialog(
      "Бүртгэлээ бүрмөсөн хаах уу?",
      isPresented: $closing,
      titleVisibility: .visible,
    ) {
      Button("Хаах", role: .destructive) {
        Task { await platform.closeAccount() }
      }
      Button("Болих", role: .cancel) {}
    } message: {
      Text("Нэр, утас, мэдэгдэл устана. Хийсэн гүйлгээ, татварын баримт хуулийн дагуу үлдэнэ. Буцаах боломжгүй.")
    }
    .task {
      await platform.refresh()
      await platform.loadPreferences()
      await platform.loadSessions()
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
      SeedAvatar(seed: platform.me?.avatarSeed ?? "00000000", size: 54)
      VStack(alignment: .leading, spacing: 5) {
        Text(platform.me?.displayName ?? "Нэргүй")
          .font(.sans(24, .semibold))
          .tracking(-0.02 * 24)
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        // The number in the mono, the way every number is; an address is words.
        if let phone = platform.me?.phone ?? (platform.me == nil ? session.phone : nil) {
          Text(spaced(phone))
            .font(.mono(14))
            .monospacedDigit()
            .foregroundStyle(Color.ink2)
        } else if let email = platform.me?.email ?? session.email {
          Text(email)
            .font(.sans(14))
            .foregroundStyle(Color.ink2)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if let me = platform.me {
          // The seed is on the screen because the avatar is derived from it:
          // somebody who wonders where their mark came from can see the answer.
          Text("Basu-д \(Format.since(me.memberSince)) хойш · \(me.avatarSeed)")
            .font(.sans(11.5))
            .lineSpacing(11.5 * 0.35 - 3)
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
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
              .foregroundStyle(Color.ink)
              .lineLimit(1)
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
          // A password is a way in only beside an address or a number to type
          // with it; an Apple account with neither adds its address first.
          if hasPassword || me.email != nil || me.phone != nil {
            Hairline()
            passwordRow(hasPassword: hasPassword)
          }
        }
      }
      .glassCard()

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

  private func passwordRow(hasPassword: Bool) -> some View {
    Button { editing = .password } label: {
      HStack(spacing: 12) {
        RowLabel(
          title: hasPassword ? "Нууц үг солих" : "Нууц үг тохируулах",
          symbol: "key",
          detail: hasPassword ? nil : "Имэйл эсвэл утас, нууц үгээр нэвтрэхийн тулд",
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
  private var settings: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Тохиргоо")
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 14) {
          RowLabel(title: "Харагдах байдал", symbol: "circle.lefthalf.filled")
          AppearancePicker(selection: $appearance)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        Hairline()
        lockRow
      }
      .glassCard()

      Text(lockFooter)
        .font(.sans(12))
        .lineSpacing(12 * 0.55 - 3)
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
    return "Харагдах байдал зөвхөн энэ утсанд хадгалагдана. Түгжээ асаалттай үед апп-аас \(minutes) минутаас удаан гарвал дахин нээхэд \(lock.kind.by) баталгаажуулна."
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
        Hairline()
        switchRow(
          "SMS-ээр",
          symbol: "message",
          detail: "Апп-аар хүрэхгүй үед мессежээр",
          isOn: platform.preferences.sms,
          id: "profile.pref.sms",
        ) { await platform.setPreference(sms: $0) }
        Hairline()
        switchRow(
          "Урамшуулал",
          symbol: "gift",
          detail: "Шинэ үйлчилгээ, хямдралын тухай",
          isOn: platform.preferences.marketing,
          id: "profile.pref.marketing",
        ) { await platform.setPreference(marketing: $0) }
      }
      .glassCard()

      // Being honest about what cannot be switched off is the difference
      // between a setting and a lie.
      Text("Захиалгын явцын мэдэгдлийг унтраах боломжгүй — гал тавих мөчийг мэдэхгүй бол урьдчилсан захиалга утгагүй болно.")
        .font(.sans(12))
        .lineSpacing(12 * 0.55 - 3)
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
      .font(.sans(14, .semibold))
      .foregroundStyle(Color.accent)
      .accessibilityIdentifier("profile.permission")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
    .background(Color.holdSoft.opacity(0.5))
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

  // MARK: - where you are signed in

  /**
   Not a feature until a phone is lost, and then the only one that matters.

   It is here so that day needs nobody's help: no email, no support queue, no
   waiting sixty days for a token to expire on its own.
   */
  @ViewBuilder private var devices: some View {
    if !platform.sessions.isEmpty {
      VStack(alignment: .leading, spacing: 11) {
        SectionLabel("Нэвтэрсэн төхөөрөмж")
        VStack(spacing: 0) {
          ForEach(Array(platform.sessions.enumerated()), id: \.element.id) { index, device in
            if index > 0 { Hairline() }
            deviceRow(device)
          }
        }
        .glassCard()

        if platform.sessions.count > 1 {
          Button("Бусад бүхнээс гарах") { signingOutOthers = true }
            .font(.sans(13, .medium))
            .foregroundStyle(Color.accent)
            .accessibilityIdentifier("profile.revokeothers")
        }
      }
    }
  }

  private func deviceRow(_ device: DeviceSession) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(device.name)
          .font(.sans(15, device.current ? .semibold : .regular))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        Text(device.current
          ? "Энэ утас"
          : "Сүүлд \(Format.when(device.lastSeenAt ?? device.createdAt))")
          .font(.mono(11))
          .foregroundStyle(Color.ink3)
      }
      Spacer(minLength: 8)
      if !device.current {
        Button("Гаргах") { Task { await platform.signOutDevice(device) } }
          .font(.sans(13, .medium))
          .foregroundStyle(Color.stop)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .accessibilityIdentifier("profile.device")
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
      .glassCard()

      // The version, because the first thing anybody is asked when they report
      // something is which build they are on, and nobody knows.
      Text("Basu \(Self.version)")
        .font(.mono(11))
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
      session.signOut()
      Task {
        await model.refreshLive()
        await platform.refresh()
      }
    } label: {
      Text("Гарах")
        .font(.sans(15, .medium))
        .foregroundStyle(Color.stop)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 15)
        .glassCard()
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("profile.signout")
  }

  /**
   Leaving, for good.

   Required by App Store review guideline 5.1.1(v): an app that makes accounts
   has to let somebody close theirs from inside it — not by email, not by
   ringing anybody. Set apart from «Гарах» and worded so the two cannot be
   confused, because one of them is reversible and the other is not.
   */
  private var closeAccount: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button("Бүртгэл хаах") { closing = true }
        .font(.sans(13))
        .foregroundStyle(Color.ink3)
        .accessibilityIdentifier("profile.close")
      if let trouble = platform.trouble {
        Banner(message: trouble)
      }
    }
    .frame(maxWidth: .infinity, alignment: .center)
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
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.sans(16))
        .foregroundStyle(tint)
        .frame(width: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.sans(15))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        if let detail {
          Text(detail)
            .font(.sans(12))
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

/**
 The switch, to the design's metrics: a 51 × 31 track at radius 16, `accent`
 on and `line2` off, a 27pt white knob inset 2 with a soft shadow.

 Drawn rather than borrowed because the system toggle's off state is a grey
 that is in nobody's token file. The row it sits in is the control — the
 whole row toggles, and is the switch to VoiceOver.
 */
struct Switch: View {
  let isOn: Bool

  var body: some View {
    ZStack(alignment: isOn ? .trailing : .leading) {
      RoundedRectangle(cornerRadius: BasuMetric.switchTrack, style: .continuous)
        .fill(isOn ? Color.accent : Color.line2)
      // White on the off track; on the accent track, whatever reads on the
      // accent — white on black, black on white in the dark.
      Circle()
        .fill(isOn ? Color.onAccent : .white)
        .frame(width: 27, height: 27)
        .shadow(color: .black.opacity(0.2), radius: 1, y: 1)
        .padding(2)
    }
    .frame(width: BasuMetric.switchSize.width, height: BasuMetric.switchSize.height)
    .animation(.easeOut(duration: 0.18), value: isOn)
    .accessibilityHidden(true)
  }
}

/**
 The one field being changed, on its own.

 A row that turns into a text field in place is a row that moves under the
 thumb and loses what was typed on the next refresh. A sheet has a Done button,
 which is what «I have finished» looks like.
 */
struct ProfileEditSheet: View {
  let field: ProfileView.Field

  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Таныг юу гэж дуудах вэ?", text: $name)
            .font(.sans(15))
            .submitLabel(.done)
            .onSubmit { save() }
            .accessibilityIdentifier("profile.name.field")
        } footer: {
          Text("Ресторанд таны ширээн дээр энэ нэр очно.")
        }
      }
      .navigationTitle("Нэр")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Болих") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Болсон") { save() }.fontWeight(.semibold)
        }
      }
    }
    .presentationDetents([.medium])
    .task {
      name = platform.me?.displayName ?? ""
    }
  }

  private func save() {
    Task {
      await platform.save(displayName: name, locale: nil)
      dismiss()
    }
  }
}

/**
 An address, for an account that has none: the way back when a password is
 forgotten, since the code that replaces one goes to an inbox.

 A code goes to the address first, so an address is never somebody else's.
 An account with a password types it too — a session can be stolen, and a
 stolen one must not be able to give itself a way back in.
 */
struct EmailAttachSheet: View {
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
    NavigationStack {
      Form {
        Section {
          TextField("Имэйл хаяг", text: $email)
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
          if needsPassword {
            HStack(spacing: 10) {
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
          if sentTo != nil {
            TextField("······", text: $code)
              .keyboardType(.numberPad)
              .textContentType(.oneTimeCode)
              .font(.mono(20, .semibold))
              .tracking(6)
              .focused($focus, equals: .code)
              .onChange(of: code) { _, typed in
                let digits = String(typed.filter(\.isNumber).prefix(6))
                if digits != typed {
                  code = digits
                  return
                }
                // Six digits is the whole code: it goes without another tap.
                if digits.count == 6 { Task { await confirm() } }
              }
              .accessibilityLabel("Имэйлд ирсэн код")
              .accessibilityIdentifier("profile.email.code")
          }
        } footer: {
          Text(footer)
        }

        if let trouble {
          Section {
            Banner(message: trouble)
              .accessibilityIdentifier("profile.email.trouble")
          }
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        }

        Section {
          WideButton(title: sentTo == nil ? "Код авах" : "Холбох", enabled: ready) {
            Task { if sentTo == nil { await send() } else { await confirm() } }
          }
          .accessibilityIdentifier("profile.email.go")
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          if sentTo != nil {
            Button("Код дахин авах") { Task { await send() } }
              .font(.sans(14))
              .buttonStyle(.borderless)
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          }
        }
      }
      .navigationTitle("Имэйл холбох")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Болих") { dismiss() }
        }
      }
    }
    .presentationDetents([.large])
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

 Every other session ends — whoever knew the old password is out — and this
 phone stays signed in. The profile says how many went (`changed`).
 */
struct PasswordChangeSheet: View {
  /// How many other devices were signed out, and whether it was the first.
  let changed: (_ revoked: Int, _ first: Bool) -> Void

  fileprivate enum Field: Hashable { case current, currentShown, next, nextShown, again, againShown }

  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var current = ""
  @State private var next = ""
  @State private var again = ""
  @State private var reveal = false
  @State private var busy = false
  @State private var trouble: String?
  @FocusState private var focus: Field?

  private var hasPassword: Bool { platform.me?.hasPassword == true }
  private var title: String { hasPassword ? "Нууц үг солих" : "Нууц үг тохируулах" }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          // The eye sits on the first row, whichever that is, and shows all three.
          if hasPassword {
            HStack(spacing: 10) {
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
            nextField
          } else {
            HStack(spacing: 10) {
              nextField
              eye
            }
          }
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
        } footer: {
          Text(footer)
        }

        if let trouble {
          Section {
            Banner(message: trouble)
              .accessibilityIdentifier("profile.password.trouble")
          }
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        }

        Section {
          WideButton(title: title, enabled: ready) {
            Task { await save() }
          }
          .accessibilityIdentifier("profile.password.go")
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Болих") { dismiss() }
        }
      }
    }
    .presentationDetents([.large])
  }

  private var nextField: some View {
    PasswordField(
      title: "Шинэ нууц үг · дор хаяж 8 тэмдэгт",
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
    return hasPassword
      ? "Солимогц бусад төхөөрөмж дээрх нэвтрэлт хаагдана, энэ утас нэвтэрсэн хэвээр үлдэнэ. \(cyrillic)"
      : "Дараа нь имэйл эсвэл утас, энэ нууц үгээрээ нэвтэрч болно. \(cyrillic)"
  }

  private var ready: Bool {
    !busy && !next.isEmpty && !again.isEmpty && (!hasPassword || !current.isEmpty)
  }

  private func save() async {
    guard ready else { return }
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
      let revoked = try await platform.changePassword(current: first ? "" : current, next: next)
      changed(revoked, first)
      dismiss()
    } catch let error as APIError {
      trouble = error.message
      if error.code == "WRONG_PASSWORD" { focus = reveal ? .currentShown : .current }
    } catch {
      trouble = "Нууц үг сольж чадсангүй. Дахин оролдоно уу."
    }
  }
}
