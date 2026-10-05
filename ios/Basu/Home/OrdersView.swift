import BasuKit
import SwiftUI

/**
 «Захиалга»: every order of the guest's the shell knows about, from both apps,
 as the launcher's own cards — what is still on its way first, then what is
 over.

 It reads what the launcher reads (`AppModel.live`, `AppModel.liveIdesh`),
 so the two never disagree; a card opens the order inside its own app, where
 the rest of its story is. Nothing here is a second copy of an app's page.
 */
struct OrdersView: View {
  let open: (Destination) -> Void

  @Environment(AppModel.self) private var model
  @Environment(Session.self) private var session
  @Environment(Platform.self) private var platform
  /// Asked for since the screen opened: until then an empty list is "not
  /// yet", not "nothing".
  @State private var loaded = false

  private var items: [LiveItem] {
    let count = model.live.count + model.liveIdesh.count
    let lunches = model.live.map { $0.asLiveItem(expanded: count == 1) }
    let provisions = model.liveIdesh.map { $0.asLiveItem() }
    return (lunches + provisions).sorted { $0.time < $1.time }
  }

  var body: some View {
    let running = items.filter { !$0.finished }
    let over = items.filter(\.finished)
    ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        if !session.isSignedIn {
          SignInPrompt(
            symbol: "receipt",
            title: "Захиалгаа энд харна",
            detail: "Нэвтэрмэгц захиалга тань энд гарна.",
            id: "orders.signin",
          )
          .padding(.top, 8)
        } else if model.offline && items.isEmpty {
          OfflineBanner { await model.retry() }
        } else if items.isEmpty {
          if loaded { empty } else { skeleton }
        } else {
          if !running.isEmpty { section("Идэвхтэй", running) }
          if !over.isEmpty { section("Дууссан", over) }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 4)
      .padding(.bottom, BasuMetric.tabBarInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.hidden)
    .background(Color.bg)
    .safeAreaInset(edge: .top, spacing: 0) { ShellTitle("Захиалга") }
    .toolbarVisibility(.hidden, for: .navigationBar)
    .refreshable { await model.refreshLive() }
    .task(id: session.token) {
      await model.refreshLive()
      loaded = true
    }
  }

  private func section(_ label: String, _ items: [LiveItem]) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionLabel(label)
        .padding(.horizontal, 4)
      ForEach(items) { item in
        Button {
          if let destination = item.destination { open(destination) }
        } label: {
          OrderCard(item: item)
        }
        .buttonStyle(Pressable())
      }
    }
  }

  /// One line and one button: nothing is running, and here is where to start.
  private var empty: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("Захиалга алга")
        .font(.display(36))
        .foregroundStyle(Color.ink)
        .accessibilityIdentifier("orders.empty")
      Text("Идэш эсвэл хоолоо эндээс захиална.")
        .font(.sans(16, .medium))
        .foregroundStyle(Color.ink2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, -8)
      WideButton(title: "Идэш сонгох") {
        if let destination = AppCatalogue.idesh.destination { open(destination) }
      }
      .accessibilityIdentifier("orders.start")
    }
    .padding(.top, 8)
  }

  /// Two cards in the shape of what is coming.
  private var skeleton: some View {
    VStack(spacing: 12) {
      ForEach(0..<2, id: \.self) { _ in
        RoundedRectangle(cornerRadius: BasuMetric.card, style: .continuous)
          .fill(Color.surface)
          .frame(height: 94)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Уншиж байна")
  }
}
