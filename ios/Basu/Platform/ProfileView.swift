import SwiftUI

/**
 The profile: a name, a language, and what Basu is allowed to send you.

 Short on purpose. A profile that grows a field per product stops being one
 person and becomes four apps sharing a form — table preference here, drop-off
 address there. Anything only one app cares about belongs to that app.
 */
struct ProfileView: View {
  @Environment(Platform.self) private var platform
  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  @State private var name = ""
  @State private var locale = "mn"
  @State private var loaded = false

  var body: some View {
    Form {
      Section {
        HStack(spacing: 14) {
          SeedAvatar(seed: platform.me?.avatarSeed ?? "00000000")
            .frame(width: 54, height: 54)
          VStack(alignment: .leading, spacing: 3) {
            Text(platform.me?.displayName ?? "Нэргүй")
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(Color.ink)
            Text(session.phone ?? platform.me?.phone ?? "—")
              .font(.mono(12))
              .foregroundStyle(Color.ink3)
          }
        }
        .padding(.vertical, 4)
      } footer: {
        if let me = platform.me {
          Text("Basu-д \(Format.since(me.memberSince))-аас хойш.")
        }
      }

      Section("Нэр") {
        TextField("Таныг юу гэж дуудах вэ?", text: $name)
          .font(.system(size: 15))
          .submitLabel(.done)
          .onSubmit { Task { await platform.save(displayName: name, locale: nil) } }
          .accessibilityIdentifier("profile.name")
      }

      Section("Хэл") {
        Picker("Хэл", selection: $locale) {
          Text("Монгол").tag("mn")
          Text("English").tag("en")
        }
        .pickerStyle(.segmented)
        .onChange(of: locale) { _, new in
          Task { await platform.save(displayName: nil, locale: new) }
        }
      }

      Section {
        Toggle("Аппаар", isOn: binding(\.push) { await platform.setPreference(push: $0) })
        Toggle("Мессежээр", isOn: binding(\.sms) { await platform.setPreference(sms: $0) })
        Toggle("Урамшуулал", isOn: binding(\.marketing) {
          await platform.setPreference(marketing: $0)
        })
      } header: {
        Text("Мэдэгдэл")
      } footer: {
        // Being honest about what cannot be switched off is the difference
        // between a setting and a lie.
        Text("Захиалгын явцын мэдэгдлийг унтраах боломжгүй — гал тавих мөчийг мэдэхгүй бол урьдчилсан захиалга утгагүй болно.")
      }

      Section {
        Button("Гарах", role: .destructive) {
          session.signOut()
          Task {
            await model.refreshLive()
            await platform.refresh()
          }
          dismiss()
        }
        .accessibilityIdentifier("profile.signout")
      } footer: {
        Text("Гарсан ч захиалга, түрийвч чинь хэвээр. Дахин нэвтэрвэл гарч ирнэ.")
      }
    }
    .navigationTitle("Бүртгэл")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await platform.refresh()
      await platform.loadPreferences()
      // Once: the fields are being typed into after this, and overwriting
      // somebody mid-word because a refresh landed is the worst kind of bug.
      guard !loaded else { return }
      name = platform.me?.displayName ?? ""
      locale = platform.me?.locale ?? "mn"
      loaded = true
    }
  }

  private func binding(
    _ path: KeyPath<NotifyPreferences, Bool>,
    set: @escaping (Bool) async -> Void,
  ) -> Binding<Bool> {
    Binding(
      get: { platform.preferences[keyPath: path] },
      set: { value in Task { await set(value) } },
    )
  }
}

/**
 A profile picture nobody had to upload.

 Drawn from the eight hex characters identity issues with the account: same
 seed, same mark, every time and on every device. That is a real avatar with no
 storage, no moderation queue and no CDN — three problems this product does not
 have yet and should not buy early.
 */
struct SeedAvatar: View {
  let seed: String

  var body: some View {
    let bytes = Array(seed.utf8).map { Int($0) }
    let hue = Double(bytes.reduce(0, +) % 360) / 360

    Canvas { context, size in
      let base = Color(hue: hue, saturation: 0.45, brightness: 0.55)
      context.fill(
        Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: size.width * 0.28),
        with: .color(base.opacity(0.18)),
      )
      // Three arcs at angles the seed picks. Enough variety to tell two
      // accounts apart at 54 points, little enough to stay a mark not a mess.
      for n in 0..<3 {
        let byte = bytes.indices.contains(n * 2) ? bytes[n * 2] : 60 * n
        let start = Angle.degrees(Double(byte % 360))
        var path = Path()
        let inset = size.width * (0.18 + 0.11 * Double(n))
        path.addArc(
          center: CGPoint(x: size.width / 2, y: size.height / 2),
          radius: size.width / 2 - inset,
          startAngle: start,
          endAngle: start + .degrees(150),
          clockwise: false,
        )
        context.stroke(
          path,
          with: .color(base.opacity(1 - Double(n) * 0.22)),
          style: StrokeStyle(lineWidth: size.width * 0.075, lineCap: .round),
        )
      }
    }
    .accessibilityHidden(true)
  }
}
