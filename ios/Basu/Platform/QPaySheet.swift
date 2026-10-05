import BasuKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/**
 Paying by QPay without leaving Basu.

 Wire confirms the invoice with QPay and hands back what QPay's own page would
 have shown: the QR's text, and every bank app that pays it, with the link that
 opens that app on this very invoice. Drawn here, natively. The person taps
 their bank — the apps on this phone first — pays there, and comes back to a
 sheet that is already asking whether the money arrived; or scans the QR from
 another phone while this one waits and keeps asking.

 What «arrived» means is the caller's (`check`): the wallet settles its
 top-up; an идэш asks through its page, which closes the sheet itself once the
 order is bought. Either way the server keeps asking QPay on its own, so a
 sheet closed early loses nothing.
 */
struct QPaySheet: View {
  let request: PayRequest
  /// One look at whether the money arrived: true when it did.
  let check: () async -> Bool
  let close: () -> Void

  @Environment(\.scenePhase) private var phase
  @Environment(\.openURL) private var openURL
  @State private var looking = false
  @State private var paid = false
  @State private var notYet = false
  @State private var noApp: String?
  /// The banks whose app is on this phone, by link: shown first.
  @State private var here: Set<String> = []
  @State private var qr: UIImage?

  var body: some View {
    ZStack {
      Color.bg.ignoresSafeArea()
      if paid {
        done.transition(.opacity)
      } else {
        paying.transition(.opacity)
      }
    }
    .animation(.easeOut(duration: 0.25), value: paid)
    .presentationDragIndicator(.visible)
    .presentationCornerRadius(BasuMetric.tile)
    .presentationBackground(Color.bg)
    .task {
      here = Set(request.invoice.banks.filter { bank in
        URL(string: bank.link).map { UIApplication.shared.canOpenURL($0) } ?? false
      }.map(\.link))
      qr = QRPicture.make(request.invoice.qr)
    }
    // Back from the bank app: asked at once, without a tap.
    .onChange(of: phase) { _, now in
      if now == .active { Task { await look(quietly: true) } }
    }
    // Paying from another phone by the QR: this one keeps asking while it is up.
    .task {
      while !Task.isCancelled && !paid {
        try? await Task.sleep(for: .seconds(4))
        if phase == .active { await look(quietly: true) }
      }
    }
  }

  // MARK: - paying

  private var paying: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        header
        amount
        VStack(alignment: .leading, spacing: 14) {
          SectionLabel("Банкны аппаар төлөх")
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 18) {
            ForEach(banks) { bank in
              BankButton(bank: bank) { open(bank) }
            }
          }
          if let noApp {
            Text("\(noApp) энэ утсанд суугаагүй байна.")
              .font(.sans(13, .medium))
              .foregroundStyle(Color.accentInk)
              .accessibilityAddTraits(.updatesFrequently)
          }
        }
        VStack(alignment: .leading, spacing: 14) {
          SectionLabel("Өөр утаснаас уншуулах")
          qrCard
        }
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.top, 22)
      .padding(.bottom, 28)
    }
    .scrollIndicators(.hidden)
    .safeAreaInset(edge: .bottom, spacing: 0) { foot }
  }

  private var header: some View {
    HStack {
      SectionLabel("QPay", colour: .gold)
      Spacer()
      Button(action: close) {
        Image(systemName: "xmark")
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(Color.ink)
          .frame(width: BasuMetric.minTarget, height: BasuMetric.minTarget)
          .glass(in: Circle())
          .contentShape(Circle())
      }
      .buttonStyle(Pressable())
      .accessibilityLabel("Хаах")
      .accessibilityIdentifier("qpay.close")
    }
  }

  private var amount: some View {
    VStack(alignment: .leading, spacing: 8) {
      Format.mntText(request.amountMnt, size: 60)
        .foregroundStyle(Color.ink)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .accessibilityIdentifier("qpay.amount")
      TimelineView(.periodic(from: .now, by: 20)) { context in
        Text(timeLeft(at: context.date))
          .font(.sans(14, .semibold))
          .foregroundStyle(lapsed(at: context.date) ? Color.accentInk : Color.gold)
      }
    }
  }

  private var qrCard: some View {
    HStack(alignment: .center, spacing: 18) {
      Group {
        if let qr {
          Image(uiImage: qr)
            .interpolation(.none)
            .resizable()
            .scaledToFit()
        } else {
          Color.clear
        }
      }
      .frame(width: 148, height: 148)
      .padding(12)
      .background(Color.white, in: RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous))
      .accessibilityLabel("QPay-ийн QR код")
      Text("Өөр утасны банкны аппаар энэ кодыг уншуулж төлнө.")
        .font(.sans(14, .medium))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .card()
  }

  private var foot: some View {
    VStack(spacing: 10) {
      if notYet {
        Text("Төлбөр хараахан ороогүй байна.")
          .font(.sans(13, .medium))
          .foregroundStyle(Color.ink3)
          .transition(.opacity)
      }
      PrimaryButton(title: "Төлсөн, шалгах", enabled: true, busy: looking) {
        Task { await look(quietly: false) }
      }
      .accessibilityIdentifier("qpay.check")
    }
    .padding(.horizontal, BasuMetric.screenPadding)
    .padding(.top, 12)
    .padding(.bottom, 10)
    .frame(maxWidth: .infinity)
    .background(Color.bg.opacity(0.96))
    .animation(.easeOut(duration: 0.2), value: notYet)
  }

  // MARK: - paid

  private var done: some View {
    VStack(spacing: 16) {
      Image(systemName: "checkmark")
        .font(.system(size: 34, weight: .bold))
        .foregroundStyle(Color.onLight)
        .frame(width: 88, height: 88)
        .background(Circle().fill(Color.ink))
      Text("Төлбөр орлоо")
        .font(.display(40))
        .foregroundStyle(Color.ink)
      Format.mntText(request.amountMnt, size: 26)
        .foregroundStyle(Color.ink2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .task {
      try? await Task.sleep(for: .seconds(1.4))
      close()
    }
  }

  // MARK: - what it does

  /// The banks, the ones on this phone first, otherwise in QPay's own order.
  private var banks: [QPayBank] {
    let all = request.invoice.banks
    return all.filter { here.contains($0.link) } + all.filter { !here.contains($0.link) }
  }

  private func open(_ bank: QPayBank) {
    guard let url = URL(string: bank.link) else { return }
    noApp = nil
    openURL(url) { opened in
      if !opened { noApp = bank.label }
    }
  }

  private func look(quietly: Bool) async {
    guard !looking, !paid else { return }
    if !quietly { looking = true }
    defer { looking = false }
    if await check() {
      notYet = false
      paid = true
    } else if !quietly {
      notYet = true
    }
  }

  private func timeLeft(at now: Date) -> String {
    guard let ends = request.invoice.expiresAt else { return "Төлбөр орж ирмэгц баталгаажна" }
    let minutes = Int((ends.timeIntervalSince(now) / 60).rounded(.up))
    return minutes > 0 ? "\(minutes) минутын дотор төлнө" : "Хугацаа дууслаа — дахин эхлүүлнэ үү"
  }

  private func lapsed(at now: Date) -> Bool {
    request.invoice.expiresAt.map { $0 <= now } ?? false
  }
}

/// One bank: its logo in a rounded square, its name under it.
private struct BankButton: View {
  let bank: QPayBank
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        logo
          .frame(width: 58, height: 58)
          .clipShape(RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous)
              .strokeBorder(Color.white.opacity(0.08), lineWidth: BasuMetric.hairline),
          )
          .shadow(color: .black.opacity(0.6), radius: 10, y: 8)
        Text(bank.label)
          .font(.sans(11, .semibold))
          .foregroundStyle(Color.ink2)
          .multilineTextAlignment(.center)
          .lineLimit(2)
          .minimumScaleFactor(0.85)
          .frame(maxWidth: .infinity)
      }
      .frame(maxWidth: .infinity)
      .frame(minHeight: BasuMetric.minTarget)
      .contentShape(Rectangle())
    }
    .buttonStyle(Pressable())
    .accessibilityLabel(bank.label)
    .accessibilityIdentifier("qpay.bank")
  }

  @ViewBuilder private var logo: some View {
    AsyncImage(url: URL(string: bank.logo)) { phase in
      if let image = phase.image {
        image.resizable().scaledToFill()
      } else {
        ZStack {
          Color.surface3
          Text(String(bank.label.prefix(1)))
            .font(.display(24))
            .foregroundStyle(Color.ink2)
        }
      }
    }
  }
}

extension QPayBank {
  /// The name a person here knows it by — QPay's Mongolian one where it has one.
  var label: String { description.isEmpty ? name : description }
}

/// A QR code's picture, drawn on the phone from QPay's text: crisp at any size.
enum QRPicture {
  static func make(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
          let image = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return UIImage(cgImage: image)
  }
}
