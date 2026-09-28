import BasuKit
import SwiftUI

/**
 «Нэвтэрсэн төхөөрөмж»: where this account is signed in, and the way out of
 each.

 Not a feature until a phone is lost, and then the only one that matters. It
 is here so that day needs nobody's help: no email, no support queue, no
 waiting sixty days for a token to expire on its own.

 The list used to be every session, one row each, which after a few weeks of
 signing in and out was a column of identical «iPhone» rows nobody could
 read. Now this phone comes first and says so, the three others seen most
 recently follow, and the rest wait behind «Бүгдийг харах». Signing out on a
 phone ends its session on the server too (`Platform.signOut`), so the list
 no longer grows by itself.
 */
struct DevicesSection: View {
  /// ProfileView's own confirmation — asked before everywhere else goes.
  @Binding var confirmingOthers: Bool

  @Environment(Platform.self) private var platform
  @State private var showingAll = false

  /// How many other devices the profile shows before «Бүгдийг харах».
  static let shown = 3

  var body: some View {
    let current = platform.sessions.first(where: \.current)
    let others = platform.sessions.filter { !$0.current }
    if !platform.sessions.isEmpty {
      VStack(alignment: .leading, spacing: 11) {
        HStack(alignment: .firstTextBaseline) {
          SectionLabel("Нэвтэрсэн төхөөрөмж")
          Spacer()
          Text("\(platform.sessions.count)")
            .font(.mono(11, .medium))
            .foregroundStyle(Color.ink3)
        }

        VStack(spacing: 0) {
          if let current { DeviceRow(device: current) }
          ForEach(Array(others.prefix(Self.shown).enumerated()), id: \.element.id) { index, device in
            if current != nil || index > 0 { Hairline() }
            DeviceRow(device: device) { await platform.signOutDevice(device) }
          }
          if others.count > Self.shown {
            Hairline()
            Button { showingAll = true } label: {
              HStack(spacing: 12) {
                Text("Бүгдийг харах")
                  .font(.sans(15, .medium))
                  .foregroundStyle(Color.ink)
                Spacer(minLength: 8)
                Text("\(others.count)")
                  .font(.mono(13, .medium))
                  .foregroundStyle(Color.ink3)
                Chevron(size: 12).foregroundStyle(Color.ink3)
              }
              .padding(.horizontal, 16)
              .padding(.vertical, 14)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("profile.devices.all")
          }
        }
        .glassCard()

        if !others.isEmpty {
          OthersOutButton(count: others.count) { confirmingOthers = true }
            .accessibilityIdentifier("profile.revokeothers")
          Text("Танихгүй төхөөрөмж харагдвал тэр даруй гаргаарай.")
            .font(.sans(12))
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .sheet(isPresented: $showingAll) { AllDevicesSheet() }
    }
  }
}

/// Every other device, for when there are more than the profile shows.
private struct AllDevicesSheet: View {
  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var confirming = false

  var body: some View {
    let others = platform.sessions.filter { !$0.current }
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          VStack(spacing: 0) {
            ForEach(Array(others.enumerated()), id: \.element.id) { index, device in
              if index > 0 { Hairline() }
              DeviceRow(device: device) { await platform.signOutDevice(device) }
            }
          }
          .glassCard()
          if !others.isEmpty {
            OthersOutButton(count: others.count) { confirming = true }
          } else {
            Text("Энэ утаснаас өөр хаана ч нэвтрээгүй байна.")
              .font(.sans(14))
              .foregroundStyle(Color.ink2)
          }
        }
        .padding(BasuMetric.screenPadding)
      }
      .background(LinearGradient.ground.ignoresSafeArea())
      .navigationTitle("Бусад төхөөрөмж")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Болсон") { dismiss() }.fontWeight(.semibold)
        }
      }
      .confirmationDialog(
        "Бусад бүх төхөөрөмжөөс гарах уу?",
        isPresented: $confirming,
        titleVisibility: .visible,
      ) {
        Button("Гаргах", role: .destructive) {
          Task { await platform.signOutOtherDevices() }
        }
        Button("Болих", role: .cancel) {}
      } message: {
        Text("Энэ утас нэвтэрсэн хэвээр үлдэнэ.")
      }
    }
    .presentationDetents([.medium, .large])
  }
}

/// One device: what it is, when it was last seen, and the way to end it.
private struct DeviceRow: View {
  let device: DeviceSession
  /// Nil for this phone — it leaves by «Гарах», not from its own row.
  var revoke: (() async -> Void)?
  @State private var revoking = false

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: device.symbol)
        .font(.sans(17))
        .foregroundStyle(Color.ink2)
        .frame(width: 38, height: 38)
        .background(Color.accentSoft, in: RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(device.shownName)
          .font(.sans(15, device.current ? .semibold : .regular))
          .foregroundStyle(Color.ink)
          .lineLimit(1)
        if device.current {
          HStack(spacing: 6) {
            Circle().fill(Color.ready).frame(width: 6, height: 6)
            Text("Энэ утас · одоо идэвхтэй")
          }
          .font(.sans(12))
          .foregroundStyle(Color.ready)
        } else {
          Text("Сүүлд \(Format.seen(device.lastSeenAt ?? device.createdAt))")
            .font(.sans(12))
            .foregroundStyle(Color.ink3)
        }
      }
      Spacer(minLength: 8)
      if let revoke {
        Button {
          Task {
            revoking = true
            await revoke()
            revoking = false
          }
        } label: {
          ZStack {
            if revoking {
              ProgressView().controlSize(.small)
            } else {
              Text("Гаргах").font(.sans(13, .medium))
            }
          }
          .foregroundStyle(Color.stop)
          .padding(.horizontal, 12)
          .frame(minWidth: 72, minHeight: 32)
          .overlay(Capsule().strokeBorder(Color.stopLine, lineWidth: BasuMetric.hairline))
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(revoking)
        .accessibilityLabel("\(device.shownName)-ийг гаргах")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("profile.device")
  }
}

/// «Бусад N төхөөрөмжөөс гаргах»: the panic button, in the colour for it.
private struct OthersOutButton: View {
  let count: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(
        count == 1 ? "Нөгөө төхөөрөмжөөс гаргах" : "Бусад \(count) төхөөрөмжөөс гаргах",
        systemImage: "rectangle.portrait.and.arrow.right",
      )
      .font(.sans(14, .medium))
      .foregroundStyle(Color.stop)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 13)
      .background(Color.stopSoft.opacity(0.6), in: RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous)
          .strokeBorder(Color.stopLine, lineWidth: BasuMetric.hairline),
      )
    }
    .buttonStyle(.plain)
  }
}

@MainActor
extension DeviceSession {
  /// What a person calls this device. This phone always has a name, even
  /// when the way it signed in — Google's round trip — gave the server none.
  var shownName: String {
    if current, label?.isEmpty != false { return Session.deviceName }
    return name
  }

  /// A mark for the kind of thing it is, read off the name it signed in with.
  var symbol: String {
    let label = (current && self.label?.isEmpty != false ? Session.deviceName : self.label ?? "").lowercased()
    if label.isEmpty { return "questionmark" }
    if label.contains("ipad") { return "ipad" }
    if label.contains("mac") { return "laptopcomputer" }
    if label.contains("вэб") || label.contains("web") { return "globe" }
    if label.contains("дэлгэц") || label.contains("tablet") { return "display" }
    return "iphone"
  }
}
