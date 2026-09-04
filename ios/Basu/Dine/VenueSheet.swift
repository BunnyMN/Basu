import SwiftUI

/**
 One restaurant: what it cooks, when it can seat you, and what that costs.

 The order of the sheet is the order of the decision — the food first, the time
 second, the money last. A slot grid at the top would ask somebody to commit to
 12:45 before they know whether they want the хуушуур.
 */
struct VenueSheet: View {
  @Bindable var model: DineModel
  @Binding var signingIn: Bool

  @Environment(AppModel.self) private var app
  @Environment(Session.self) private var session
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 0, pinnedViews: []) {
          // How far, whether they are open, and what people think — under the
          // name rather than squeezed into the bar beside it, where it would
          // arrive as "6 ми…".
          Text(subtitle)
            .font(.mono(11))
            .foregroundStyle(Color.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.bottom, 12)

          ForEach(model.menu) { item in
            MenuRow(item: item, table: app.dishes, qty: model.cart[item.id] ?? 0) { qty in
              if qty <= 0 { model.cart[item.id] = nil } else { model.cart[item.id] = qty }
            }
            Divider().padding(.leading, 86)
          }

          if !model.slots.isEmpty {
            SectionLabel("Хэдэн цагт суух вэ")
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 18)
              .padding(.top, 18)
              .padding(.bottom, 10)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 82), spacing: 7)], spacing: 7) {
              ForEach(model.slots) { slot in
                SlotChip(
                  slot: slot,
                  chosen: model.slot == slot.startsAt,
                ) { model.slot = slot.startsAt }
              }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 18)
          }

          if let said = model.venueReviews, !said.comments.isEmpty {
            SectionLabel("Зочид юу гэсэн бэ")
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 18)
              .padding(.bottom, 8)
            VStack(spacing: 10) {
              ForEach(said.comments) { comment in
                CommentRow(comment: comment)
              }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 20)
          }
        }
      }
      .background(Color.surface)
      .navigationTitle(model.venue?.name ?? "")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { dismiss() } label: { Image(systemName: "xmark") }
            .accessibilityIdentifier("venue.close")
        }
      }
      .safeAreaInset(edge: .bottom) { footer }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  private var subtitle: String {
    guard let venue = model.venue else { return "" }
    var parts = ["\(venue.walkMinutes) мин алхаад"]
    parts.append(venue.acceptingOrders ? "захиалга авч байна" : "хаалттай")
    if let walk = model.walk {
      parts.append("\(Format.metres(walk.metres))\(walk.isGuess ? " ойролцоо" : "")")
    }
    if let rating = venue.rating, rating.count > 0 {
      parts.append("★ \(String(format: "%.1f", rating.stars)) (\(rating.count))")
    }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder
  private var footer: some View {
    VStack(spacing: 9) {
      if let trouble = model.trouble {
        Banner(message: trouble)
      }

      Text("Хоол ")
        .font(.sans(12.5))
        .foregroundStyle(Color.ink2)
        + Text("гал дээр гарахаас өмнө").font(.sans(12.5, .semibold)).foregroundStyle(Color.accentInk)
        + Text(" үнэгүй цуцална.").font(.sans(12.5)).foregroundStyle(Color.ink2)

      if !session.isSignedIn {
        WideButton(title: "Нэвтэрч захиалах", enabled: !model.cart.isEmpty) {
          signingIn = true
        }
      } else {
        WideButton(
          title: model.busy
            ? "Түр хүлээнэ үү…"
            : model.slot == nil
              ? "Цагаа сонгоно уу"
              : "\(Format.mnt(model.total)) төлөх",
          enabled: !model.busy && model.slot != nil && !model.cart.isEmpty,
        ) {
          Task { await model.placeOrder() }
        }
        .accessibilityIdentifier("venue.pay")
      }
    }
    .padding(.horizontal, 18)
    .padding(.top, 12)
    .padding(.bottom, 14)
    .background(.regularMaterial)
    .overlay(alignment: .top) { Divider() }
  }
}

/// One dish: the picture, the two numbers the kitchen runs on, and the price.
struct MenuRow: View {
  let item: MenuItem
  let table: DishTable
  let qty: Int
  let change: (Int) -> Void

  var body: some View {
    HStack(spacing: 12) {
      DishThumb(item: item, table: table)
        .opacity(item.soldOut ? 0.45 : 1)

      VStack(alignment: .leading, spacing: 2) {
        Text(item.name)
          .font(.sans(15, .medium))
          .foregroundStyle(item.soldOut ? Color.ink3 : Color.ink)
          .strikethrough(item.soldOut)
        if let description = item.description, !description.isEmpty {
          Text(description)
            .font(.sans(12.5))
            .foregroundStyle(Color.ink2)
            .lineLimit(2)
        }
        HStack(spacing: 6) {
          Text("\(item.station) · \(item.prepMinutes) мин")
          if let rating = item.rating, rating.count > 0 {
            Text("★ \(String(format: "%.1f", rating.stars))")
          }
        }
        .font(.mono(10))
        .foregroundStyle(Color.ink3)
      }

      Spacer(minLength: 4)

      VStack(alignment: .trailing, spacing: 6) {
        Text(Format.mnt(item.priceMnt))
          .font(.mono(13))
          .foregroundStyle(Color.ink)
        if !item.soldOut {
          Stepper(qty: qty, id: item.name, change: change)
        } else {
          Text("дууссан")
            .font(.mono(9.5))
            .foregroundStyle(Color.ink3)
        }
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 10)
  }
}

/// Minus, the count, plus — the whole of ordering more than one of something.
struct Stepper: View {
  let qty: Int
  /// Names this row's two buttons, so a test can add one хуушуур rather than
  /// one of whatever happens to be first on the menu.
  let id: String
  let change: (Int) -> Void

  var body: some View {
    HStack(spacing: 0) {
      button("minus") { change(qty - 1) }
        .disabled(qty == 0)
        .opacity(qty == 0 ? 0.4 : 1)
        .accessibilityIdentifier("qty.\(id).minus")
      Text("\(qty)")
        .font(.mono(12))
        .frame(width: 26)
        .foregroundStyle(Color.ink)
      button("plus") { change(qty + 1) }
        .accessibilityIdentifier("qty.\(id).plus")
    }
    .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.line2, lineWidth: 1))
  }

  private func button(_ symbol: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.sans(11, .semibold))
        .frame(width: 30, height: 30)
        .foregroundStyle(Color.ink2)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// One sitting. A full slot is struck through rather than hidden: knowing that
/// 12:30 is gone is how somebody chooses 12:45.
struct SlotChip: View {
  let slot: Slot
  let chosen: Bool
  let pick: () -> Void

  var body: some View {
    Button(action: pick) {
      Text(slot.label)
        .font(.mono(14))
        .strikethrough(!slot.available)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .foregroundStyle(chosen ? .white : (slot.available ? Color.ink2 : Color.ink3))
        .background(chosen ? Color.accent : Color.surface, in: RoundedRectangle(cornerRadius: 3))
        .overlay(
          RoundedRectangle(cornerRadius: 3)
            .stroke(chosen ? Color.accent : Color.line2, lineWidth: 1),
        )
        .opacity(slot.available ? 1 : 0.34)
    }
    .buttonStyle(.plain)
    .disabled(!slot.available)
    .accessibilityIdentifier("slot.\(slot.label)")
  }
}

struct CommentRow: View {
  let comment: PublicComment

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(String(repeating: "★", count: comment.stars))
          .font(.sans(11))
          .foregroundStyle(Color.accentInk)
        Text(comment.by)
          .font(.mono(10))
          .foregroundStyle(Color.ink3)
        if let onTime = comment.onTime {
          Text(onTime ? "цагтаа" : "хоцорсон")
            .font(.mono(9.5))
            .foregroundStyle(onTime ? Color.ready : Color.hold)
        }
      }
      Text(comment.comment)
        .font(.sans(13))
        .foregroundStyle(Color.ink2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(11)
    .background(Color.surface2, in: RoundedRectangle(cornerRadius: 4))
  }
}
