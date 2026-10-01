import BasuKit
import SwiftUI

/**
 The wallet: what is in it, how to put more in, and where the last lot went.

 One number is the screen; everything under it exists to explain that number.
 There is no chart and no monthly total on purpose — nobody opens a wallet to
 see a trend, they open it to find out whether the next thing will work.

 Putting money in is offered only while it can be done. A server without a
 payment key refuses every top-up; the first refusal turns the amounts into
 one plain line (`Platform.topupsOpen`) rather than a row of buttons that all
 end in the same no.
 */
struct WalletView: View {
  @Environment(Session.self) private var session
  @Environment(Platform.self) private var platform
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var confirming: Int?
  @State private var customAmount = false
  @State private var showing: WalletLine?

  /// Three amounts, not a keypad. Roughly two lunches, a week, and a fortnight.
  private let amounts = [20_000, 50_000, 100_000]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        if session.isSignedIn {
          balance
          topUp
          statement
        } else {
          // Somebody looking around has no wallet yet: it is the account's.
          SignInPrompt(
            symbol: "creditcard",
            title: "Нэвтэрмэгц түрийвч тань энд гарна",
            detail: "Үлдэгдэл, буцаалт, баримт — бүгд нэг дор.",
            id: "wallet.signin",
          )
          .padding(.top, 8)
        }
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top, spacing: 0) { ShellTitle("Түрийвч") }
    .toolbarVisibility(.hidden, for: .navigationBar)
    // An alert rather than a confirmation dialog: on iOS 26 the dialog is a
    // popover with no visible «Болих», and paying is not a thing to do by
    // tapping beside it.
    .alert(
      confirming.map { "\(Format.mnt($0)) цэнэглэх үү?" } ?? "",
      isPresented: .init(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
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
          .lineLimit(1)
          .minimumScaleFactor(0.5)
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
      Text("Захиалгын төлбөр эндээс хасагдана. Дутвал зөрүүг QPay-ээр төлнө.")
        .font(.sans(13.5))
        .lineSpacing(13.5 * 0.5 - 3)
        .foregroundStyle(Color.ink2)
        .frame(maxWidth: 300, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder private var topUp: some View {
    VStack(alignment: .leading, spacing: 11) {
      SectionLabel("Цэнэглэх")
      if platform.topupsOpen {
        // A grid rather than a row so the largest text sizes get two to a
        // line instead of amounts broken across two.
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: typeSize.isAccessibilitySize ? 2 : 4),
          spacing: 8,
        ) {
          ForEach(amounts, id: \.self) { amount in
            Button {
              confirming = amount
            } label: {
              Format.mntText(amount, size: 14)
                .foregroundStyle(Color.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .chip()
            }
            .buttonStyle(.plain)
            // Holding an amount still opens the fourth way; «Өөр дүн» says it out loud.
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in customAmount = true })
            .disabled(platform.toppingUp)
            .accessibilityIdentifier("wallet.topup.\(amount)")
            .accessibilityAction(named: "Өөр дүн") { customAmount = true }
          }
          // The fourth way, for the person who needs 37 000₮ and would
          // otherwise top up twice. It used to be a long press nobody found.
          Button {
            customAmount = true
          } label: {
            Text("Өөр дүн")
              .font(.sans(14, .medium))
              .foregroundStyle(Color.accentInk)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
              .chip()
          }
          .buttonStyle(.plain)
          .disabled(platform.toppingUp)
          .accessibilityIdentifier("wallet.topup.other")
        }
        if let trouble = platform.trouble {
          Banner(message: trouble)
        }
      } else {
        // Said once, plainly, with nothing promised: no buttons that all
        // end in the same refusal, and no «soon».
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "lock")
            .font(.sans(15))
            .foregroundStyle(Color.ink3)
            .accessibilityHidden(true)
          Text("Цэнэглэлт одоогоор хаалттай байна.")
            .font(.sans(14))
            .foregroundStyle(Color.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard(radius: BasuMetric.button)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("wallet.topup.closed")
      }
    }
  }

  @ViewBuilder private var statement: some View {
    VStack(alignment: .leading, spacing: 4) {
      SectionLabel("Гүйлгээ")
        .padding(.bottom, 8)

      if platform.wallet.lines.isEmpty {
        Hairline()
        Text("Гүйлгээ алга. Захиалгын төлбөр, буцаалт энд харагдана.")
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

private extension View {
  /// An amount to tap: glass, a hairline, the button corner.
  func chip() -> some View {
    frame(maxWidth: .infinity)
      .padding(.vertical, 15)
      .padding(.horizontal, 6)
      .glassCard(radius: BasuMetric.button, stroke: .line2)
      .contentShape(Rectangle())
  }
}

/// Any amount, for the person the three buttons do not fit.
struct TopUpAmountSheet: View {
  let pick: (Int) -> Void

  @State private var text = ""
  @FocusState private var typing: Bool

  private var amount: Int? {
    let digits = text.filter(\.isNumber)
    guard let value = Int(digits), value >= 1_000, value <= 2_000_000 else { return nil }
    return value
  }

  var body: some View {
    ProfileSheet(title: "Цэнэглэх дүн") {
      VStack(spacing: 12) {
        AuthField(symbol: "creditcard", active: typing) { typing = true } content: {
          HStack(spacing: 4) {
            TextField("Дүн", text: $text)
              .keyboardType(.numberPad)
              .font(.mono(18, .semibold))
              .focused($typing)
              .accessibilityIdentifier("wallet.amount.field")
            Text("₮")
              .font(.sans(18, .semibold))
              .foregroundStyle(Color.ink3)
              .accessibilityHidden(true)
          }
        }
        Note(text: "1,000₮-с 2,000,000₮ хооронд.")
        PrimaryButton(title: "Үргэлжлүүлэх", enabled: amount != nil, busy: false) {
          if let amount { pick(amount) }
        }
        .accessibilityIdentifier("wallet.amount.go")
      }
      .padding(18)
      .authCard()
    }
    .presentationDetents([.medium, .large])
    .onAppear { typing = true }
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
    let shown = line.shown
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(line.title)
            Format.signedText(signed, size: 34)
              .foregroundStyle(line.amountMnt > 0 ? Color.ready : Color.ink)
              .lineLimit(1)
              .minimumScaleFactor(0.5)
            Text(shown.title == line.title ? shown.detail : "\(shown.title) · \(shown.detail)")
              .font(.sans(14))
              .foregroundStyle(Color.ink2)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: 0) {
            detail("Огноо", Format.date(line.at))
            Hairline()
            detail("Цаг", Format.hhmm(line.at), mono: true)
            if let number = shown.number {
              Hairline()
              detail("Захиалгын дугаар", "№\(number)", mono: true)
            }
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
            ? "Цэнэглэлтэд баримт гардаггүй — баримтыг худалдсан ресторан, нийлүүлэгч гаргана."
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
        .monospacedDigit()
        .foregroundStyle(Color.ink)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .accessibilityElement(children: .combine)
  }

  private var signed: String {
    line.amountMnt < 0 ? "−\(Format.grouped(-line.amountMnt))" : "+\(Format.grouped(line.amountMnt))"
  }
}

/// One movement: who or what it was, which app and order, and what it did.
struct StatementRow: View {
  let line: WalletLine

  var body: some View {
    let shown = line.shown
    VStack(spacing: 0) {
      Hairline()
      HStack(alignment: .top, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          // Who it was with leads — «Улаанбаатар махны төв» says more than
          // «Захиалга», which every other line also says.
          Text(shown.title)
            .font(.sans(15, .medium))
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
          shown.subline
            .foregroundStyle(Color.ink3)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        VStack(alignment: .trailing, spacing: 5) {
          Format.signedText(signed, size: 15)
            // Money arriving is the only thing on this screen worth colour.
            .foregroundStyle(line.amountMnt > 0 ? Color.ready : Color.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
          Text(Format.when(line.at))
            .font(.mono(11))
            .monospacedDigit()
            .foregroundStyle(Color.ink3)
        }
        .fixedSize(horizontal: true, vertical: false)
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

extension WalletLine {
  /**
   A movement the way the statement says it: who or what it was with, which
   app it came from, and the order's number.

   The vertical writes all three into the memo — «Идэш · Улаанбаатар махны
   төв №7001» — so the shell can say them without knowing what an идэш is. The
   ledger's own word («Захиалга») is the row's title only when there is
   nothing more particular to say; a refund keeps «Буцаалт» first, since
   which way the money went is the point of it.
   */
  struct Shown: Equatable {
    let title: String
    let detail: String
    let number: String?

    /// «Идэш · №7001» — words in the sans, the number in the mono.
    var subline: Text {
      let words = Text(detail).font(.sans(13))
      guard let number else { return words }
      return words + Text(detail.isEmpty ? "" : " · ").font(.sans(13)) + Text("№\(number)").font(.mono(12))
    }
  }

  var shown: Shown { Self.shown(kind: kind, memo: memo) }

  static func shown(kind: String, memo: String?) -> Shown {
    let word = Movement.word(for: kind)
    if kind == "topup" { return Shown(title: word, detail: "QPay", number: nil) }
    guard let memo = memo?.trimmingCharacters(in: .whitespaces), !memo.isEmpty else {
      return Shown(title: word, detail: "Basu", number: nil)
    }
    var number: String?
    var parts = memo.components(separatedBy: "·").map { $0.trimmingCharacters(in: .whitespaces) }
    for index in parts.indices {
      if let found = parts[index].range(of: #"№\s*\d+"#, options: .regularExpression) {
        number = String(parts[index][found].filter(\.isNumber))
        parts[index].removeSubrange(found)
        parts[index] = parts[index].trimmingCharacters(in: .whitespaces)
      }
    }
    parts.removeAll(where: \.isEmpty)
    guard let app = parts.first else { return Shown(title: word, detail: "Basu", number: number) }
    let rest = Array(parts.dropFirst())
    if kind == "refund" {
      return Shown(title: word, detail: ([app] + rest.filter { $0 != word }).joined(separator: " · "), number: number)
    }
    guard let what = rest.first else { return Shown(title: word, detail: app, number: number) }
    return Shown(title: what, detail: ([app] + rest.dropFirst()).joined(separator: " · "), number: number)
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
 The nav bar of a pushed shell screen: «‹ Basu» on the left in `accentInk`,
 the title centred at 17/600, and an empty right cell. Three columns, so the
 title is centred on the screen and not on what is left of it. The back says
 where it goes in the words every app page uses for the launcher — «‹ Basu» —
 so there is one way back in the whole app, not three.
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
          HStack(spacing: 4) {
            Chevron(direction: .back, size: 18)
            Text("Basu")
              .font(.sans(15, .medium))
          }
          .foregroundStyle(Color.accentInk)
          .frame(minWidth: BasuMetric.minTarget, minHeight: BasuMetric.minTarget, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("shell.back")
        .accessibilityLabel("Basu нүүр")
        Spacer()
      }
    }
    // A bar, like the system's: it grows with the text up to where the back
    // and the title still sit side by side, and no further.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .frame(height: 44)
    .padding(.top, 4 - (44 - 20) / 2)
    .padding(.horizontal, BasuMetric.screenPadding - 4)
    .padding(.bottom, 18 - (44 - 20) / 2)
    .background(Color.groundTop.ignoresSafeArea(edges: .top))
  }
}
