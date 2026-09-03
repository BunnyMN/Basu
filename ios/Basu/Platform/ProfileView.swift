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
        signOut
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
    .task {
      await platform.refresh()
      await platform.loadPreferences()
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
