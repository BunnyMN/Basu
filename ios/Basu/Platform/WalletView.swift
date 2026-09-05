import BasuKit
import SwiftUI

/**
 The wallet: what is in it, how to put more in, and where the last lot went.

 One number is the screen; everything under it exists to explain that number.
 There is no chart and no monthly total on purpose — nobody opens a wallet to
 see a trend, they open it to find out whether the next thing will work.
 */
struct WalletView: View {
  @Environment(Platform.self) private var platform
  @State private var confirming: Int?
  @State private var customAmount = false
  @State private var showing: WalletLine?

  /// Three amounts, not a keypad. Roughly two lunches, a week, and a fortnight.
  private let amounts = [20_000, 50_000, 100_000]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        balance
        topUp
        statement
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, 78)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top, spacing: 0) { ShellTitle("Түрийвч") }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .confirmationDialog(
      confirming.map { "\(Format.mnt($0)) цэнэглэх үү?" } ?? "",
      isPresented: .init(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible,
    ) {
      Button("QPay-ээр төлөх") {
        if let amount = confirming { Task { _ = await platform.topUp(amountMnt: amount) } }
        confirming = nil
      }
      Button("Болих", role: .cancel) { confirming = nil }
    } message: {
      Text("Мөнгө орж ирсний дараа л үлдэгдэл нэмэгдэнэ.")
    }
    .sheet(isPresented: $customAmount) {
      TopUpAmountSheet { amount in
        customAmount = false
        confirming = amount
      }
    }
    .sheet(item: $showing) { line in
      MovementSheet(line: line)
    }
    .refreshable { await platform.loadWallet() }
    .task { await platform.loadWallet() }
  }

  /// One number, then only what explains it. A failed fetch omits the number
  /// rather than showing a zero — a wallet that says 0₮ when it means «I do not
  /// know» is the one thing here that could make somebody top up twice.
  private var balance: some View {
    VStack(alignment: .leading, spacing: 12) {
      if platform.balanceKnown {
        Format.mntText(platform.wallet.balanceMnt, size: 48)
          .kerning(-0.02 * 48)
          .foregroundStyle(Color.ink)
          .contentTransition(.numericText())
          .accessibilityIdentifier("wallet.balance")
      } else {
        Button {
          Task { await platform.loadWallet() }
        } label: {
          Text("Үлдэгдэл уншигдсангүй — дахин")
            .font(.sans(15, .medium))
            .foregroundStyle(Color.accent)
            .frame(minHeight: 48)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("wallet.retry")
      }
      Text("Хоолны төлбөр эндээс хасагдана. Дутвал зөрүүг нь л асууна.")
        .font(.sans(13.5))
        .lineSpacing(13.5 * 0.5 - 3)
        .foregroundStyle(Color.ink2)
        .frame(maxWidth: 262, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var topUp: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Цэнэглэх")
      HStack(spacing: 10) {
        ForEach(amounts, id: \.self) { amount in
          Button {
            confirming = amount
          } label: {
            Format.mntText(amount, size: 14)
              .foregroundStyle(Color.ink)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 15)
              .padding(.horizontal, 6)
              .glassCard(stroke: .line2)
          }
          .buttonStyle(.plain)
          // Three amounts cover most of it. Holding one is the fourth way,
          // for the person who needs 37 000₮ and would otherwise top up twice.
          .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in customAmount = true })
          .disabled(platform.toppingUp)
          .accessibilityIdentifier("wallet.topup.\(amount)")
          .accessibilityAction(named: "Өөр дүн") { customAmount = true }
        }
      }
      if let trouble = platform.trouble {
        Banner(message: trouble)
      }
    }
  }

  @ViewBuilder private var statement: some View {
    VStack(alignment: .leading, spacing: 4) {
      SectionLabel("Гүйлгээ")
        .padding(.bottom, 8)

      if platform.wallet.lines.isEmpty {
        Hairline()
        Text("Гүйлгээ алга. Цэнэглэвэл энд харагдана.")
          .font(.sans(14))
          .lineSpacing(14 * 0.6 - 4)
          .foregroundStyle(Color.ink2)
          .padding(.top, 26)
          .frame(maxWidth: 300, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        ForEach(platform.wallet.lines) { line in
          Button { showing = line } label: { StatementRow(line: line) }
            .buttonStyle(.plain)
        }

        if platform.wallet.next != nil {
          Hairline()
          Button {
            Task { await platform.loadMoreWallet() }
          } label: {
            Text(platform.loadingMore ? "Уншиж байна…" : "Цааш үзэх")
              .font(.sans(13, .medium))
              .foregroundStyle(Color.accent)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 16)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(platform.loadingMore)
          .accessibilityIdentifier("wallet.more")
        }
      }
    }
  }
}

/// Any amount, for the person the three buttons do not fit.
struct TopUpAmountSheet: View {
  let pick: (Int) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var text = ""

  private var amount: Int? {
    let digits = text.filter(\.isNumber)
    guard let value = Int(digits), value >= 1_000, value <= 2_000_000 else { return nil }
    return value
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Дүн", text: $text)
            .keyboardType(.numberPad)
            .font(.mono(20, .semibold))
            .accessibilityIdentifier("wallet.amount.field")
        } footer: {
          Text("1,000₮-с 2,000,000₮ хооронд.")
        }
      }
      .navigationTitle("Цэнэглэх дүн")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Болих") { dismiss() } }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Үргэлжлүүлэх") { if let amount { pick(amount) } }
            .fontWeight(.semibold)
            .disabled(amount == nil)
        }
      }
    }
    .presentationDetents([.medium])
  }
}

/**
 One movement, and its tax receipt.

 The receipt is the reason this screen exists. In Mongolia it is not a nicety:
 somebody claiming lunch back needs the ДДТД and the lottery number, and making
 them find the order it came from to get at it is making them know how the
 software is built.
 */
struct MovementSheet: View {
  let line: WalletLine

  @Environment(Platform.self) private var platform
  @Environment(\.dismiss) private var dismiss
  @State private var movement: Movement?
  @State private var loading = true

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(line.title)
            Format.signedText(signed, size: 34)
              .foregroundStyle(line.amountMnt > 0 ? Color.ready : Color.ink)
            Text(line.source)
              .font(.mono(12))
              .foregroundStyle(Color.ink3)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: 0) {
            detail("Огноо", Format.when(line.at))
            Hairline()
            detail("Цаг", Format.hhmm(line.at))
            Hairline()
            detail("Дугаар", String(line.id.prefix(8)), mono: true)
          }
          .glassCard()

          receipt
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(LinearGradient.ground)
      .navigationTitle("Гүйлгээ")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Хаах") { dismiss() } }
      }
    }
    .task {
      movement = await platform.movement(line.id)
      loading = false
    }
  }

  @ViewBuilder private var receipt: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Е-баримт")
      if let receipt = movement?.receipt {
        VStack(alignment: .leading, spacing: 10) {
          if let lottery = receipt.lottery {
            HStack {
              Text("Сугалааны дугаар")
                .font(.sans(14))
                .foregroundStyle(Color.ink2)
              Spacer(minLength: 8)
              Text(lottery)
                .font(.mono(15, .semibold))
                .foregroundStyle(Color.ink)
                .textSelection(.enabled)
            }
          }
          Text(receipt.qr)
            .font(.mono(11))
            .foregroundStyle(Color.ink3)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
        .accessibilityIdentifier("movement.receipt")
      } else {
        // Said out loud. A blank space where a receipt should be is the same
        // picture as "we lost it", and one of those is true.
        Text(loading
          ? "Уншиж байна…"
          : line.kind == "topup"
            ? "Цэнэглэлтэд баримт гардаггүй — баримт хоол зарсан ресторанаас гарна."
            : "Баримт хараахан гараагүй байна. Захиалга хаагдмагц энд гарч ирнэ.")
          .font(.sans(13))
          .lineSpacing(3.5)
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func detail(_ label: String, _ value: String, mono: Bool = false) -> some View {
    HStack(spacing: 12) {
      Text(label)
        .font(.sans(15))
        .foregroundStyle(Color.ink2)
      Spacer(minLength: 8)
      Text(value)
        .font(mono ? .mono(14) : .sans(15, .medium))
        .foregroundStyle(Color.ink)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
  }

  private var signed: String {
    line.amountMnt < 0 ? "−\(Format.grouped(-line.amountMnt))" : "+\(Format.grouped(line.amountMnt))"
  }
}

/// One movement: what it was, which app it came from, and what it did.
struct StatementRow: View {
  let line: WalletLine

  var body: some View {
    VStack(spacing: 0) {
      Hairline()
      HStack(alignment: .top, spacing: 16) {
        VStack(alignment: .leading, spacing: 5) {
          Text(line.title)
            .font(.sans(15, .medium))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
          // The source names the app, because with several apps a bare
          // «Захиалга» stops saying anything.
          Text(line.source)
            .font(.mono(11.5))
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        VStack(alignment: .trailing, spacing: 5) {
          Format.signedText(signed, size: 15)
            // Money arriving is the only thing on this screen worth colour.
            .foregroundStyle(line.amountMnt > 0 ? Color.ready : Color.ink)
          Text(Format.when(line.at))
            .font(.mono(11))
            .monospacedDigit()
            .foregroundStyle(Color.ink3)
        }
        .fixedSize()
      }
      .padding(.vertical, 14)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("wallet.line.\(line.kind)")
  }

  /// A real minus sign, not a hyphen: the two sit at different heights and a
  /// column of amounts is read downward.
  private var signed: String {
    line.amountMnt < 0 ? "−\(Format.grouped(-line.amountMnt))" : "+\(Format.grouped(line.amountMnt))"
  }
}

/**
 The title a tab root carries: 28/600, tracked −0.02em, padding 2 × 20 × 16.

 Wallet and Profile are roots, not pushed screens — there is nothing to go back
 to, so there is no back link. The glass under it is the same the tab bar has,
 so content scrolling up runs under a surface rather than a gap.
 */
struct ShellTitle: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text)
      .font(.sans(28, .semibold))
      .tracking(-0.02 * 28)
      .foregroundStyle(Color.ink)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 2)
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, 16)
      .background(Color.groundTop.ignoresSafeArea(edges: .top))
      .accessibilityAddTraits(.isHeader)
  }
}

/**
 The nav bar of a pushed shell screen: a chevron on the left in `accent`, the
 title centred at 17/600, and an empty right cell. Three columns, so the title
 is centred on the screen and not on what is left of it.
 */
struct ShellNav: View {
  let title: String
  let back: () -> Void

  var body: some View {
    ZStack {
      Text(title)
        .font(.sans(17, .semibold))
        .tracking(-0.01 * 17)
        .foregroundStyle(Color.ink)
        .accessibilityAddTraits(.isHeader)
      HStack {
        Button(action: back) {
          Chevron(direction: .back, size: 20)
            .foregroundStyle(Color.accent)
            .frame(width: BasuMetric.minTarget, height: BasuMetric.minTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("shell.back")
        .accessibilityLabel("Буцах")
        Spacer()
      }
    }
    .frame(height: 44)
    .padding(.top, 4 - (44 - 20) / 2)
    .padding(.horizontal, BasuMetric.screenPadding)
    .padding(.bottom, 18 - (44 - 20) / 2)
    .background(Color.groundTop.ignoresSafeArea(edges: .top))
  }
}
