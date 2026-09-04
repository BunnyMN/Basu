import SwiftUI

/**
 One order, while it is happening.

 The five steps are the guest's whole mental model of the thing: placed,
 accepted, on the fire, ready, on the table. Everything else on this screen —
 the arm question, the cancel button, the receipt — hangs off which of those
 five is current.
 */
struct StatusSheet: View {
  @Bindable var model: DineModel
  @Environment(\.dismiss) private var dismiss
  @State private var reviewing = false

  private static let steps: [(key: String, label: String)] = [
    ("placed", "Захиалга баталгаажлаа"),
    ("accepted", "Ресторан хүлээн авлаа"),
    ("fired", "Гал дээр гарлаа"),
    ("ready", "Хоол бэлэн"),
    ("served", "Ширээн дээр"),
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        if let order = model.order {
          VStack(spacing: 16) {
            headline(order)
            steps(order)
            if let walk = model.walk { walkLine(walk) }
            actions(order)
            if let receipt = order.receipt { receiptCard(receipt) }
            if order.canReview { reviewCard(order) }
          }
          .padding(18)
        } else {
          ProgressView().padding(40)
        }
      }
      .background(Color.bg)
      .navigationTitle(model.order.map { "№\($0.code)" } ?? "")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { dismiss() } label: { Image(systemName: "xmark") }
            .accessibilityIdentifier("status.close")
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .sheet(isPresented: $reviewing) { ReviewSheet(model: model) }
  }

  // MARK: the parts

  private func headline(_ order: OrderDetail) -> some View {
    VStack(spacing: 6) {
      Text(order.state.rawValue)
        .font(.mono(10))
        .tracking(1.6)
        .foregroundStyle(Color.ink3)
      // The states that carry a time say it; the rest carry a word.
      Text(order.state.headline?.word ?? Format.hhmm(order.fireAt))
        .font(.sans(32, .black))
        .kerning(-1)
        .foregroundStyle(Color.ink)
        .multilineTextAlignment(.center)
      if let sub = order.state.subtitle, !sub.isEmpty {
        Text(order.state == .cooking ? "\(Format.hhmm(order.readyAt))-д бэлэн болно" : sub)
          .font(.sans(14))
          .foregroundStyle(Color.ink2)
      }
      HStack(spacing: 8) {
        Text(order.restaurant.name)
          .font(.sans(13, .medium))
          .foregroundStyle(Color.ink2)
        if let table = order.table {
          Text("Ширээ \(table)")
            .font(.mono(11))
            .foregroundStyle(Color.ink3)
        }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 18)
    .background(order.state.soft, in: RoundedRectangle(cornerRadius: 6))
    .overlay(RoundedRectangle(cornerRadius: 6).stroke(order.state.line, lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("status.card")
  }

  private func steps(_ order: OrderDetail) -> some View {
    let done: [String: Bool] = [
      "placed": true,
      "accepted": order.state != .placed,
      "fired": [.fired, .cooking, .ready, .served, .closed].contains(order.state),
      "ready": [.ready, .served, .closed].contains(order.state),
      "served": [.served, .closed].contains(order.state),
    ]
    let when: [String: Date?] = [
      "placed": order.slotStartsAt,
      "fired": order.fireAt,
      "ready": order.readyAt,
    ]

    return VStack(spacing: 0) {
      ForEach(Self.steps, id: \.key) { step in
        HStack(spacing: 12) {
          Text(when[step.key].flatMap { $0 }.map(Format.hhmm) ?? "·")
            .font(.mono(12))
            .foregroundStyle(Color.ink3)
            .frame(width: 44, alignment: .leading)
          Text(step.label)
            .font(.sans(14, done[step.key] == true ? .semibold : .regular))
            .foregroundStyle(done[step.key] == true ? Color.ink : Color.ink3)
          Spacer()
          if done[step.key] == true {
            Image(systemName: "checkmark")
              .font(.sans(11, .bold))
              .foregroundStyle(Color.ready)
          }
        }
        .padding(.vertical, 11)
        if step.key != Self.steps.last?.key { Divider() }
      }
    }
    .padding(.horizontal, 14)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 6))
    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.line, lineWidth: 1))
  }

  private func walkLine(_ walk: Walk) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "figure.walk")
      Text("\(Format.metres(walk.metres)) · \(walk.minutes) мин")
        .font(.mono(12))
      if walk.isGuess {
        Text("ойролцоо")
          .font(.mono(10))
          .foregroundStyle(Color.ink3)
      }
      Spacer()
    }
    .foregroundStyle(Color.route)
    .padding(12)
    .background(Color.routeSoft, in: RoundedRectangle(cornerRadius: 4))
  }

  @ViewBuilder
  private func actions(_ order: OrderDetail) -> some View {
    VStack(spacing: 10) {
      // T−15: the question the whole fire time turns on.
      if order.state == .armed || order.state == .scheduled {
        HStack(spacing: 10) {
          WideButton(title: "Замд гарсан", kind: .primary, enabled: !model.busy) {
            Task { await model.sayOnMyWay() }
          }
          .accessibilityIdentifier("status.onmyway")
          WideButton(title: "10 мин хойшлуулах", kind: .quiet, enabled: !model.busy) {
            Task { await model.delayTen() }
          }
        }
      }

      if order.canCancel {
        WideButton(title: "Үнэгүй цуцлах", kind: .danger, enabled: !model.busy) {
          Task { await model.cancel() }
        }
        .accessibilityIdentifier("status.cancel")
        if let until = order.freeCancelUntil {
          Text("\(Format.hhmm(until))-аас өмнө үнэгүй")
            .font(.mono(10.5))
            .foregroundStyle(Color.ink3)
        }
      }

      if let trouble = model.trouble {
        Banner(message: trouble)
      }
    }
  }

  private func receiptCard(_ receipt: Receipt) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionLabel("Е-баримт")
      Text(receipt.qr)
        .font(.mono(10))
        .foregroundStyle(Color.ink2)
        .lineLimit(2)
        .truncationMode(.middle)
      if let lottery = receipt.lottery {
        Text("Сугалаа: \(lottery)")
          .font(.mono(11))
          .foregroundStyle(Color.ink)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
  }

  @ViewBuilder
  private func reviewCard(_ order: OrderDetail) -> some View {
    if let review = order.review {
      VStack(alignment: .leading, spacing: 6) {
        SectionLabel("Таны үнэлгээ")
        Text(String(repeating: "★", count: review.stars))
          .foregroundStyle(Color.accentInk)
        if let comment = review.comment, !comment.isEmpty {
          Text(comment)
            .font(.sans(13))
            .foregroundStyle(Color.ink2)
        }
        Button("Өөрчлөх") { reviewing = true }
          .font(.sans(13))
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
      .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.line, lineWidth: 1))
    } else {
      WideButton(title: "Үнэлгээ өгөх", kind: .quiet) { reviewing = true }
        .accessibilityIdentifier("status.review")
    }
  }
}
