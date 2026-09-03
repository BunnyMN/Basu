import SwiftUI

/**
 The wallet: what is in it, how to put more in, and where the last lot went.

 The balance is the screen. Everything under it exists to explain that number,
 which is why the statement is a plain list of signed amounts rather than a
 chart — nobody opens a wallet to see a trend, they open it to find out whether
 lunch is going to work.
 */
struct WalletView: View {
  @Environment(Platform.self) private var platform
  @State private var confirming: Int?

  /// Three amounts, not a keypad. They are roughly two lunches, a week, and a
  /// fortnight at pilot prices, which is the whole decision most people make.
  private let amounts = [20_000, 50_000, 100_000]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        balance
        topUp
        statement
      }
      .padding(.horizontal, 18)
      .padding(.top, 8)
      .padding(.bottom, 28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Color.bg)
    // Attached to the screen, not to the row of amount buttons: a dialog
    // presented from inside a ScrollView goes with the view when SwiftUI
    // rebuilds it, and sometimes never appears at all.
    .confirmationDialog(
      confirming.map { "\(Format.mnt($0)) цэнэглэх үү?" } ?? "",
      isPresented: .init(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible,
    ) {
      Button("QPay-ээр төлөх") {
        if let amount = confirming {
          Task { _ = await platform.topUp(amountMnt: amount) }
        }
        confirming = nil
      }
      Button("Болих", role: .cancel) { confirming = nil }
    } message: {
      Text("Мөнгө орж ирсний дараа л үлдэгдэл нэмэгдэнэ.")
    }
    .navigationTitle("Түрийвч")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await platform.loadWallet() }
    .task { await platform.loadWallet() }
  }

  private var balance: some View {
    VStack(alignment: .leading, spacing: 4) {
      SectionLabel("Үлдэгдэл")
      Text(Format.mnt(platform.wallet.balanceMnt))
        .font(.mono(38, .semibold))
        .foregroundStyle(Color.ink)
        .contentTransition(.numericText())
        .accessibilityIdentifier("wallet.balance")
      Text("Хоолны төлбөр эндээс хасагдана. Дутвал зөрүүг нь л асууна.")
        .font(.system(size: 12.5))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
    .overlay(alignment: .leading) { Rectangle().fill(Color.accent).frame(width: 3) }
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
    .clipShape(RoundedRectangle(cornerRadius: 4))
    .padding(.bottom, 24)
  }

  private var topUp: some View {
    VStack(alignment: .leading, spacing: 10) {
      SectionLabel("Цэнэглэх")
      HStack(spacing: 8) {
        ForEach(amounts, id: \.self) { amount in
          Button {
            confirming = amount
          } label: {
            Text(Format.mnt(amount))
              .font(.mono(14, .medium))
              .foregroundStyle(Color.ink)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 14)
              .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
              .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line2, lineWidth: 1))
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
    .padding(.bottom, 26)
  }

  @ViewBuilder private var statement: some View {
    SectionLabel("Гүйлгээ")
      .padding(.bottom, 10)

    if platform.wallet.lines.isEmpty {
      Text("Гүйлгээ алга. Цэнэглэвэл энд харагдана.")
        .font(.system(size: 13))
        .foregroundStyle(Color.ink3)
        .padding(.vertical, 18)
    } else {
      VStack(spacing: 0) {
        ForEach(Array(platform.wallet.lines.enumerated()), id: \.element.id) { index, line in
          StatementRow(line: line)
          if index < platform.wallet.lines.count - 1 {
            Rectangle().fill(Color.line).frame(height: 1)
          }
        }
      }
      .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
    }
  }
}

/// One movement: what it was, when, and what it did to the balance.
struct StatementRow: View {
  let line: WalletLine

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(line.title)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Color.ink)
        Text(Format.when(line.at))
          .font(.mono(10.5))
          .foregroundStyle(Color.ink3)
      }
      Spacer(minLength: 8)
      Text(Format.signedMnt(line.amountMnt))
        .font(.mono(15, .medium))
        // Money arriving is the only thing here worth colour.
        .foregroundStyle(line.amountMnt > 0 ? Color.ready : Color.ink)
        .monospacedDigit()
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 13)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("wallet.line.\(line.kind)")
  }
}
