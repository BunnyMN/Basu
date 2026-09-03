import SwiftUI

/**
 The clock, as a control.

 Service runs 11:30–14:00 and the gap the whole product lives in is fifteen
 minutes long, so a walkthrough cannot wait for the real hour. Every jump also
 runs a scheduler pass: otherwise time moves and nothing acts on it.

 The strip appears only when the server answers `/dev/clock` — that is, only in
 demo mode. In production the route is not mounted and this draws nothing.
 */
struct DemoClockBar: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if model.clockIsControllable {
      // One scrolling row, so the last control is reachable on a narrow phone
      // rather than sliced off at the edge.
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          Text("ДЕМО ЦАГ")
            .font(.mono(9))
            .tracking(1.4)
            .foregroundStyle(Color.ink3)
          Text(model.clockLabel ?? "—")
            .font(.mono(14, .semibold))
            .foregroundStyle(Color.ink)
            .padding(.trailing, 4)

          jump("11:40")
          jump("12:14")
          jump("12:21")
          step("+1", minutes: 1)
          step("+5", minutes: 5)
          Button { Task { await model.runScheduler() } } label: {
            Text("Scheduler")
              .font(.mono(10, .semibold))
              .padding(.horizontal, 9)
              .padding(.vertical, 5)
              .background(Color.accent, in: RoundedRectangle(cornerRadius: 2))
              .foregroundStyle(.white)
          }
          .accessibilityIdentifier("clock.tick")
        }
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 7)
      .background(Color.sunk)
      .overlay(alignment: .bottom) { Divider() }
    }
  }

  private func jump(_ label: String) -> some View {
    button(label) { await model.setClock(to: label) }
  }

  private func step(_ label: String, minutes: Int) -> some View {
    button(label) { await model.advanceClock(minutes: minutes) }
  }

  private func button(_ label: String, _ action: @escaping () async -> Void) -> some View {
    Button { Task { await action() } } label: {
      Text(label)
        .font(.mono(10))
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 2))
        .overlay(RoundedRectangle(cornerRadius: 2).stroke(Color.line2, lineWidth: 1))
        .foregroundStyle(Color.ink2)
    }
    .accessibilityIdentifier("clock.\(label)")
  }
}
