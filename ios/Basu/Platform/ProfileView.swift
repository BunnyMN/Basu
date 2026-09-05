import BasuKit
import SwiftUI

/**
 The profile: who you are, and what Basu is allowed to send you.

 Short on purpose. A profile that grows a field per product stops being one
 person and becomes four apps sharing a form — table preference here, drop-off
 address there. Anything only one app cares about belongs to that app.
 */
struct ProfileView: View {
  /// Where signing out or closing the account lands: the launcher.
  let home: () -> Void

  @Environment(Platform.self) private var platform
  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model

  @State private var editing: Field?
  @State private var closing = false
  @State private var signingOutOthers = false
  @State private var signingIn = false

  enum Field: String, Identifiable {
    case name, locale
    var id: String { rawValue }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        if session.isSignedIn {
          identity
          fields
          notifications
          devices
          help
          signOut
          closeAccount
        } else {
          signedOut
        }
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, 78)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top, spacing: 0) { ShellTitle("Профайл") }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .sheet(isPresented: $signingIn) { SignInSheet() }
    .sheet(item: $editing) { field in
      ProfileEditSheet(field: field)
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
        Task { if await platform.closeAccount() { home() } }
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
        Text(spaced(platform.me?.phone ?? session.phone ?? "—"))
          .font(.mono(14))
          .monospacedDigit()
          .foregroundStyle(Color.ink2)
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
    VStack(spacing: 0) {
      row(label: "Нэр", value: platform.me?.displayName ?? "—") { editing = .name }
      Hairline()
      row(label: "Хэл", value: platform.me?.locale == "en" ? "English" : "Монгол") {
        editing = .locale
      }
    }
    .glassCard()
  }

  private func row(label: String, value: String, tap: @escaping () -> Void) -> some View {
    Button(action: tap) {
      HStack(spacing: 12) {
        Text(label)
          .font(.sans(15))
          .foregroundStyle(Color.ink2)
        Spacer(minLength: 8)
        Text(value)
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
    .accessibilityIdentifier("profile.\(label == "Нэр" ? "name" : "locale")")
  }

  // MARK: - what we may send

  private var notifications: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Мэдэгдэл")
      VStack(spacing: 0) {
        switchRow("Аппаар", isOn: platform.preferences.push) {
          await platform.setPreference(push: $0)
        }
        Hairline()
        switchRow("Мессежээр", isOn: platform.preferences.sms) {
          await platform.setPreference(sms: $0)
        }
        Hairline()
        switchRow("Урамшуулал", isOn: platform.preferences.marketing) {
          await platform.setPreference(marketing: $0)
        }
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

  private func switchRow(
    _ name: String,
    isOn: Bool,
    set: @escaping (Bool) async -> Void,
  ) -> some View {
    Button {
      Task { await set(!isOn) }
    } label: {
      HStack(spacing: 14) {
        Text(name)
          .font(.sans(15))
          .lineSpacing(15 * 0.35 - 4)
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        Switch(isOn: isOn)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 13)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(name)
    .accessibilityValue(isOn ? "асаалттай" : "унтраалттай")
    .accessibilityAddTraits(.isToggle)
    .accessibilityIdentifier("profile.pref.\(name)")
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

  private var help: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Тусламж")
      VStack(spacing: 0) {
        link("Үйлчилгээний нөхцөл", "https://basu.mn/terms")
        Hairline()
        link("Нууцлалын бодлого", "https://basu.mn/privacy")
        Hairline()
        link("Холбоо барих", "mailto:tuslah@basu.mn")
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

  private func link(_ title: String, _ url: String) -> some View {
    Link(destination: URL(string: url)!) {
      HStack(spacing: 12) {
        Text(title)
          .font(.sans(15))
          .foregroundStyle(Color.ink)
        Spacer(minLength: 8)
        Chevron(size: 13).foregroundStyle(Color.ink3)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .contentShape(Rectangle())
    }
  }

  private var signOut: some View {
    Button {
      session.signOut()
      Task {
        await model.refreshLive()
        await platform.refresh()
      }
      home()
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

extension ProfileView {
  /// Signed out there is no profile to show, and pretending otherwise would be
  /// drawing a person who is not there. One card, one way in.
  fileprivate var signedOut: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Утасны дугаараараа нэвтэрнэ. Нууц үг байхгүй — нэг удаагийн код ирнэ.")
        .font(.sans(14))
        .lineSpacing(14 * 0.6 - 4)
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
      Button {
        signingIn = true
      } label: {
        Text("Нэвтрэх")
          .font(.sans(15, .medium))
          .foregroundStyle(Color.accent)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 15)
          .glassCard()
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("profile.signin")
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
      Circle()
        .fill(.white)
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
  @State private var locale = "mn"

  var body: some View {
    NavigationStack {
      Form {
        switch field {
        case .name:
          Section {
            TextField("Таныг юу гэж дуудах вэ?", text: $name)
              .font(.sans(15))
              .submitLabel(.done)
              .onSubmit { save() }
              .accessibilityIdentifier("profile.name.field")
          } footer: {
            Text("Ресторанд таны ширээн дээр энэ нэр очно.")
          }
        case .locale:
          Picker("Хэл", selection: $locale) {
            Text("Монгол").tag("mn")
            Text("English").tag("en")
          }
          .pickerStyle(.inline)
        }
      }
      .navigationTitle(field == .name ? "Нэр" : "Хэл")
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
      locale = platform.me?.locale ?? "mn"
    }
  }

  private func save() {
    Task {
      switch field {
      case .name: await platform.save(displayName: name, locale: nil)
      case .locale: await platform.save(displayName: nil, locale: locale)
      }
      dismiss()
    }
  }
}
