import BasuKit
import SwiftUI

/**
 Where a signed-out visitor meets something that is theirs alone — the
 wallet, the profile, the orders — the way in is offered, not forced.

 The app is open to look around (App Review guideline 5.1.1(v): an account
 may be asked for only where the feature is the account's). So a browsing
 visitor sees the launcher and both apps' stalls and menus; the wallet, the
 orders and the profile say what they are for in a line and open the
 sign-in sheet with the screen's one crimson button.
 */
struct SignInPrompt: View {
  let symbol: String
  let title: String
  let detail: String
  var id = "signin.prompt"

  @State private var signingIn = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Image(systemName: symbol)
        .font(.sans(22, .medium))
        .foregroundStyle(Color.ink)
        .frame(width: 52, height: 52)
        .background(Color.surface3, in: RoundedRectangle(cornerRadius: BasuMetric.inner, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 8) {
        Text(title)
          .font(.display(29))
          .foregroundStyle(Color.ink)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Text(detail)
          .font(.sans(15, .medium))
          .foregroundStyle(Color.ink2)
          .fixedSize(horizontal: false, vertical: true)
      }
      WideButton(title: "Нэвтрэх") { signingIn = true }
        .accessibilityIdentifier(id)
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .card(radius: BasuMetric.card)
    .sheet(isPresented: $signingIn) { SignInSheet() }
  }
}
