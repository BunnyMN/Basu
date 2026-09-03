import SwiftUI

/**
 Stars, and the one question this product is actually judged on.

 "Was it on time?" is kept separate from "was it good?" because they are
 different failures with different owners: a cold хуушуур is the kitchen's, a
 хуушуур that arrived twenty minutes after you sat down is ours.
 */
struct ReviewSheet: View {
  @Bindable var model: DineModel
  @Environment(\.dismiss) private var dismiss

  @State private var stars = 0
  @State private var onTime: Bool?
  @State private var comment = ""
  @State private var dishStars: [String: Int] = [:]

  var body: some View {
    NavigationStack {
      Form {
        Section("Хоол ямар байсан бэ?") {
          HStack {
            Spacer()
            StarPicker(stars: $stars)
              .accessibilityIdentifier("review.stars")
            Spacer()
          }
          .padding(.vertical, 4)
        }

        Section("Цагтаа гарсан уу?") {
          Picker("", selection: Binding(
            get: { onTime },
            set: { onTime = $0 },
          )) {
            Text("Тийм").tag(Bool?.some(true))
            Text("Үгүй").tag(Bool?.some(false))
            Text("Хэлэхгүй").tag(Bool?.none)
          }
          .pickerStyle(.segmented)
        }

        if let lines = model.order?.lines, !lines.isEmpty {
          Section("Хоол тус бүрээр") {
            ForEach(lines) { line in
              HStack {
                Text("\(line.name) ×\(line.qty)")
                  .font(.system(size: 14))
                Spacer()
                StarPicker(
                  stars: Binding(
                    get: { dishStars[line.menuItemId] ?? 0 },
                    set: { dishStars[line.menuItemId] = $0 },
                  ),
                  size: 16,
                )
              }
            }
          }
        }

        Section("Нэмж хэлэх зүйл") {
          TextField("Заавал биш", text: $comment, axis: .vertical)
            .lineLimit(2...5)
        }

        Section {
          WideButton(title: "Илгээх", enabled: stars > 0 && !model.busy) {
            Task {
              await model.review(
                stars: stars,
                onTime: onTime,
                comment: comment,
                dishes: dishStars.filter { $0.value > 0 },
              )
              dismiss()
            }
          }
          .accessibilityIdentifier("review.send")
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
        }
      }
      .navigationTitle("Үнэлгээ")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Болих") { dismiss() } }
      }
    }
    .presentationDetents([.large])
    .onAppear {
      guard let review = model.order?.review else { return }
      stars = review.stars
      onTime = review.onTime
      comment = review.comment ?? ""
      dishStars = Dictionary(uniqueKeysWithValues: review.dishes.map { ($0.menuItemId, $0.stars) })
    }
  }
}
