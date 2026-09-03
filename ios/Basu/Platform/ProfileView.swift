import SwiftUI

/**
 The profile: who you are, and what Basu is allowed to send you.

 Short on purpose. A profile that grows a field per product stops being one
 person and becomes four apps sharing a form — table preference here, drop-off
 address there. Anything only one app cares about belongs to that app.
 */
struct ProfileView: View {
  let back: () -> Void

  @Environment(Platform.self) private var platform
  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model

  @State private var editing: Field?
  @State private var closing = false
  @State private var signingOutOthers = false

  enum Field: String, Identifiable {
    case name, locale
    var id: String { rawValue }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        identity
        fields
        notifications
        devices
        help
        signOut
        closeAccount
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 88)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top) { ShellHeader(back: back) }
    .toolbarVisibility(.hidden, for: .navigationBar)
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
        Task { if await platform.closeAccount() { back() } }
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
          .font(.system(size: 24, weight: .semibold))
          .kerning(-0.48)
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
            .font(.system(size: 11.5))
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
          .font(.system(size: 15))
          .foregroundStyle(Color.ink2)
        Spacer(minLength: 8)
        Text(value)
          .font(.system(size: 15, weight: .medium))
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
        .font(.system(size: 12))
        .lineSpacing(4.6)
        .foregroundStyle(Color.ink3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func switchRow(
    _ name: String,
    isOn: Bool,
    set: @escaping (Bool) async -> Void,
  ) -> some View {
    HStack(spacing: 14) {
      Text(name)
        .font(.system(size: 15))
        .foregroundStyle(Color.ink)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      Toggle("", isOn: .init(get: { isOn }, set: { value in Task { await set(value) } }))
        .labelsHidden()
        .tint(.accent)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 13)
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
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Color.accentInk)
            .accessibilityIdentifier("profile.revokeothers")
        }
      }
    }
  }

  private func deviceRow(_ device: DeviceSession) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(device.name)
          .font(.system(size: 15, weight: device.current ? .semibold : .regular))
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
          .font(.system(size: 13, weight: .medium))
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
          .font(.system(size: 15))
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
      back()
    } label: {
      Text("Гарах")
        .font(.system(size: 15, weight: .medium))
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
        .font(.system(size: 13))
        .foregroundStyle(Color.ink3)
        .accessibilityIdentifier("profile.close")
      if let trouble = platform.trouble {
        Banner(message: trouble)
      }
    }
    .frame(maxWidth: .infinity, alignment: .center)
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
              .font(.system(size: 15))
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
