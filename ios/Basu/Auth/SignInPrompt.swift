import BasuKit
import SwiftUI

/**
 Where a signed-out visitor meets something that is theirs alone — the
 wallet, the profile — the way in is offered, not forced.

 The app is open to look around (App Review guideline 5.1.1(v): an account
 may be asked for only where the feature is the account's). So a browsing
 visitor sees the launcher and both apps' stalls and menus; the wallet and
 the profile say what they are for and open the sign-in sheet.
 */
struct SignInPrompt: View {
  let symbol: String
  let title: String
  let detail: String
  var id = "signin.prompt"

  @State private var signingIn = false

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Image(systemName: symbol)
        .font(.sans(22, .medium))
        .foregroundStyle(Color.accent)
        .frame(width: 48, height: 48)
        .background(Color.accentSoft, in: RoundedRectangle(cornerRadius: BasuMetric.control, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text(title)
          .font(.sans(20, .semibold))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
        Text(detail)
          .font(.sans(14))
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      WideButton(title: "Нэвтрэх") { signingIn = true }
        .accessibilityIdentifier(id)
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassCard(radius: BasuMetric.authCard)
    .sheet(isPresented: $signingIn) { SignInSheet() }
  }
}
