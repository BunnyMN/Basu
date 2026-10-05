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
      VStack(alignment: .leading, spacing: 36) {
        if session.isSignedIn {
          balance
          topUp
          statement
        } else {
          // Somebody looking around has no wallet yet: it is the account's.
          SignInPrompt(
            symbol: "creditcard",
            title: "Түрийвч тань энд",
            detail: "Үлдэгдэл, буцаалт, баримт нэг дор.",
            id: "wallet.signin",
          )
          .padding(.top, 8)
        }
      }
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.top, 4)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(Color.bg)
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
    // QPay, paid without leaving the app: the bank apps and the QR.
    .sheet(item: Binding(get: { platform.paying }, set: { platform.paying = $0 })) { request in
      QPaySheet(request: request, check: { await platform.lookAtTopup() }) {
        platform.paying = nil
      }
    }
    .refreshable { await platform.loadWallet() }
    .task { await platform.loadWallet() }
  }

  /// One number, then only what explains it. A failed fetch omits the number
  /// rather than showing a zero — a wallet that says 0₮ when it means «I do not
  /// know» is the one thing here that could make somebody top up twice.
  private var balance: some View {
    VStack(alignment: .leading, spacing: 10) {
      SectionLabel("Үлдэгдэл", colour: .gold)
      if platform.balanceKnown {
        Format.mntText(platform.wallet.balanceMnt, size: 72)
          .foregroundStyle(Color.ink)
          .lineLimit(1)
          .minimumScaleFactor(0.5)
          .contentTransition(.numericText())
          .accessibilityIdentifier("wallet.balance")
      } else {
        Button {
          Task { await platform.loadWallet() }
        } label: {
          HStack(spacing: 10) {
            Text("Үлдэгдэл уншигдсангүй")
              .foregroundStyle(Color.ink2)
            Text("Дахин")
              .foregroundStyle(Color.ink)
              .underline()
          }
          .font(.sans(16, .semibold))
          .frame(minHeight: 72, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("wallet.retry")
      }
      // The second line is a promise only while money can come in.
      Text(platform.topupsOpen
        ? "Захиалгын төлбөр эндээс хасагдана. Дутвал QPay-ээр."
        : "Захиалгын төлбөр эндээс хасагдана.")
        .font(.sans(15, .medium))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder private var topUp: some View {
    VStack(alignment: .leading, spacing: 12) {
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
              Format.mntText(amount, size: 19)
                .foregroundStyle(Color.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .chip()
            }
            .buttonStyle(Pressable())
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
              .font(.sans(14, .bold))
              .foregroundStyle(Color.ink)
              .lineLimit(1)
              .minimumScaleFactor(0.7)
              .chip()
          }
          .buttonStyle(Pressable())
          .disabled(platform.toppingUp)
          .accessibilityIdentifier("wallet.topup.other")
        }
        if let trouble = platform.trouble {
          Banner(message: trouble)
        }
      } else {
        // Said once, plainly, with nothing promised: no buttons that all
        // end in the same refusal, and no «soon».
        HStack(alignment: .center, spacing: 12) {
          Image(systemName: "lock")
            .font(.sans(16, .medium))
            .foregroundStyle(Color.ink3)
            .accessibilityHidden(true)
          Text("Цэнэглэлт одоогоор хаалттай.")
            .font(.sans(15, .semibold))
            .foregroundStyle(Color.ink2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("wallet.topup.closed")
      }
    }
  }

  /// The movements as a table's rows on one card: who or what, which app and
  /// order, and the money in the display face on the right.
  @ViewBuilder private var statement: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionLabel("Гүйлгээ")

      if platform.wallet.lines.isEmpty {
        Text("Гүйлгээ алга.")
          .font(.sans(15, .medium))
          .foregroundStyle(Color.ink2)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 18)
          .padding(.vertical, 22)
          .card()
      } else {
        VStack(spacing: 0) {
          ForEach(Array(platform.wallet.lines.enumerated()), id: \.element.id) { index, line in
            if index > 0 { Hairline() }
            Button { showing = line } label: { StatementRow(line: line) }
              .buttonStyle(.plain)
          }

          if platform.wallet.next != nil {
            Hairline()
            Button {
              Task { await platform.loadMoreWallet() }
            } label: {
              Text(platform.loadingMore ? "Уншиж байна…" : "Цааш үзэх")
                .font(.sans(14, .bold))
                .foregroundStyle(Color.ink)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 56)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(platform.loadingMore)
            .accessibilityIdentifier("wallet.more")
          }
        }
        .card()
      }
    }
  }
}

private extension View {
  /// An amount to tap: an outlined capsule.
  func chip() -> some View {
    frame(maxWidth: .infinity)
      .frame(minHeight: 52)
      .padding(.horizontal, 6)
      .background(Color.surface, in: Capsule())
      .overlay(Capsule().strokeBorder(Color.line2, lineWidth: BasuMetric.hairline))
      .contentShape(Capsule())
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
            TextField("Дүн", text: $text, prompt: placeholder("Дүн"))
              .keyboardType(.numberPad)
              .font(.display(26))
              .monospacedDigit()
              .focused($typing)
              .accessibilityIdentifier("wallet.amount.field")
            Text("₮")
              .font(.display(26))
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
        VStack(alignment: .leading, spacing: 28) {
          VStack(alignment: .leading, spacing: 10) {
            SectionLabel(line.title, colour: .gold)
            Format.signedText(signed, size: 56)
              .foregroundStyle(Color.ink)
              .lineLimit(1)
              .minimumScaleFactor(0.5)
            Text(shown.title == line.title ? shown.detail : "\(shown.title) · \(shown.detail)")
              .font(.sans(15, .medium))
              .foregroundStyle(Color.ink2)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: 0) {
            detail("Огноо", Format.date(line.at))
            Hairline()
            detail("Цаг", Format.hhmm(line.at), figures: true)
            if let number = shown.number {
              Hairline()
              detail("Захиалгын дугаар", "№\(number)", figures: true)
            }
          }
          .card()

          receipt
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .containerBackground(for: .navigation) { Color.surface2.ignoresSafeArea() }
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
    VStack(alignment: .leading, spacing: 12) {
      SectionLabel("Е-баримт")
      if let receipt = movement?.receipt {
        VStack(alignment: .leading, spacing: 12) {
          if let lottery = receipt.lottery {
            HStack(alignment: .firstTextBaseline) {
              Text("Сугалааны дугаар")
                .font(.sans(15, .medium))
                .foregroundStyle(Color.ink2)
              Spacer(minLength: 8)
              Text(lottery)
                .font(.display(22))
                .monospacedDigit()
                .foregroundStyle(Color.ink)
                .textSelection(.enabled)
            }
          }
          Text(receipt.qr)
            .font(.sans(12, .medium))
            .monospacedDigit()
            .foregroundStyle(Color.ink3)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityIdentifier("movement.receipt")
      } else {
        // Said out loud. A blank space where a receipt should be is the same
        // picture as "we lost it", and one of those is true.
        Text(loading
          ? "Уншиж байна…"
          : line.kind == "topup"
            ? "Цэнэглэлтэд баримт гардаггүй — баримтыг худалдсан ресторан, нийлүүлэгч гаргана."
            : "Баримт хараахан гараагүй байна. Захиалга хаагдмагц энд гарч ирнэ.")
          .font(.sans(14, .medium))
          .lineSpacing(3)
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func detail(_ label: String, _ value: String, figures: Bool = false) -> some View {
    HStack(spacing: 12) {
      Text(label)
        .font(.sans(15, .medium))
        .foregroundStyle(Color.ink2)
      Spacer(minLength: 8)
      Text(value)
        .font(figures ? .display(20) : .sans(15, .semibold))
        .monospacedDigit()
        .foregroundStyle(Color.ink)
    }
    .padding(.horizontal, 18)
    .frame(minHeight: 56)
    .accessibilityElement(children: .combine)
  }

  private var signed: String {
    line.amountMnt < 0 ? "−\(Format.grouped(-line.amountMnt))" : "+\(Format.grouped(line.amountMnt))"
  }
}

/// One movement, as a table's row: who or what it was with, which app and
/// order, and the money in the display face with the day under it.
struct StatementRow: View {
  let line: WalletLine

  var body: some View {
    let shown = line.shown
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        // Who it was with leads — «Улаанбаатар махны төв» says more than
        // «Захиалга», which every other line also says.
        Text(shown.title)
          .font(.sans(16, .bold))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        shown.subline
          .foregroundStyle(Color.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 6) {
        // Money in and money out are told apart by the sign, not by a
        // colour: there is no green here.
        Format.signedText(signed, size: 22)
          .foregroundStyle(Color.ink)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
        Text(Format.when(line.at))
          .font(.sans(12, .semibold))
          .monospacedDigit()
          .foregroundStyle(Color.ink3)
      }
      .fixedSize(horizontal: true, vertical: false)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 14)
    .frame(minHeight: 72)
    .contentShape(Rectangle())
    // Said in words: the row combined read out «№», «·» and «₮» one by one.
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken(shown))
    .accessibilityIdentifier("wallet.line.\(line.kind)")
  }

  private func spoken(_ shown: WalletLine.Shown) -> String {
    let money = Format.moneySpoken(line.amountMnt) + (line.amountMnt < 0 ? " хасагдсан" : " орсон")
    let parts = [
      shown.title,
      Format.spoken(shown.detail),
      shown.number.map { "захиалга \($0)" },
      money,
      Format.whenSpoken(line.at),
    ]
    return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
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

    /// «Идэш · №7001» — the words, then the number in tabular figures.
    var subline: Text {
      let words = Text(detail).font(.sans(13, .semibold))
      guard let number else { return words }
      return words + Text(detail.isEmpty ? "" : " · ").font(.sans(13, .semibold)) + Text("№\(number)").font(.sans(13, .semibold)).monospacedDigit()
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
 The title a tab root carries: the display face at 44, on the ground.

 The orders, the wallet and the profile are roots, not pushed screens — there
 is nothing to go back to, so there is no back link. The ground under the
 title is the screen's own, so content scrolling up runs under it rather than
 into the clock.
 */
struct ShellTitle: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    Text(text)
      .font(.display(44))
      .foregroundStyle(Color.ink)
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 12)
      .padding(.horizontal, BasuMetric.screenPadding)
      .padding(.bottom, 20)
      .background(Color.bg.ignoresSafeArea(edges: .top))
      .accessibilityAddTraits(.isHeader)
  }
}

/**
 The bar of a pushed shell screen: the way back as a round glass button on
 the left, the title centred, and an empty right cell — so the title is
 centred on the screen and not on what is left of it. Back goes to the
 launcher, and VoiceOver says so («Basu нүүр»).
 */
struct ShellNav: View {
  let title: String
  let back: () -> Void

  var body: some View {
    ZStack {
      Text(title)
        .font(.sans(17, .bold))
        .foregroundStyle(Color.ink)
        .accessibilityAddTraits(.isHeader)
      HStack {
        Button(action: back) {
          Chevron(direction: .back, size: 18, lineWidth: 2)
            .foregroundStyle(Color.ink)
            .frame(width: BasuMetric.minTarget, height: BasuMetric.minTarget)
            .glass(in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(Pressable())
        .accessibilityIdentifier("shell.back")
        .accessibilityLabel("Basu нүүр")
        Spacer()
      }
    }
    // A bar, like the system's: it grows with the text up to where the back
    // and the title still sit side by side, and no further.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .frame(minHeight: BasuMetric.minTarget)
    .padding(.top, 4)
    .padding(.horizontal, 16)
    .padding(.bottom, 12)
    .background(Color.bg.ignoresSafeArea(edges: .top))
  }
}
