import SwiftUI

/**
 The wallet: what is in it, how to put more in, and where the last lot went.

 One number is the screen; everything under it exists to explain that number.
 There is no chart and no monthly total on purpose — nobody opens a wallet to
 see a trend, they open it to find out whether the next thing will work.
 */
struct WalletView: View {
  let back: () -> Void

  @Environment(Platform.self) private var platform
  @State private var confirming: Int?

  /// Three amounts, not a keypad. Roughly two lunches, a week, and a fortnight.
  private let amounts = [20_000, 50_000, 100_000]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        balance
        topUp
        statement
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 88)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(LinearGradient.ground)
    .safeAreaInset(edge: .top) { ShellHeader(back: back) }
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
    .refreshable { await platform.loadWallet() }
    .task { await platform.loadWallet() }
  }

  private var balance: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionLabel("Түрийвч")
      Format.mntText(platform.wallet.balanceMnt, size: 48)
        .kerning(-0.96)
        .foregroundStyle(Color.ink)
        .contentTransition(.numericText())
        .accessibilityIdentifier("wallet.balance")
      Text("Хоолны төлбөр эндээс хасагдана. Дутвал зөрүүг нь л асууна.")
        .font(.system(size: 13.5))
        .lineSpacing(3)
        .foregroundStyle(Color.ink2)
        .frame(maxWidth: 280, alignment: .leading)
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
          .disabled(platform.toppingUp)
          .accessibilityIdentifier("wallet.topup.\(amount)")
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
          .font(.system(size: 14))
          .lineSpacing(4)
          .foregroundStyle(Color.ink2)
          .padding(.top, 26)
          .frame(maxWidth: 300, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        ForEach(platform.wallet.lines) { line in
          StatementRow(line: line)
        }
      }
    }
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
            .font(.system(size: 15, weight: .medium))
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
 The way back to the launcher: a chevron and the word `Basu`.

 Not a bare arrow. The shell has a name, and a person two screens deep should
 be told what they are going back to rather than left to remember.
 */
struct ShellHeader: View {
  let back: () -> Void
  var title: String?
  var trailing: AnyView?

  var body: some View {
    HStack(spacing: 6) {
      Button(action: back) {
        HStack(spacing: 6) {
          Chevron(direction: .back, size: 20)
          Text("Basu").font(.system(size: 15, weight: .medium))
        }
        .foregroundStyle(Color.accent)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("shell.back")

      Spacer(minLength: 8)
      if let trailing { trailing }
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 2)
  }
}
