import BasuKit
import SwiftUI
import UIKit

/**
 Light, dark, or whatever the phone says.

 Kept on the phone, not the account: it is about this screen in this room,
 and somebody with two phones may well want two answers.

 Applied to the windows themselves rather than through `preferredColorScheme`:
 that one does not always let go when it is set back to nil, and «Систем»
 has to mean the phone's own setting again at once, sheets and web pages
 included — a `WKWebView` inherits the window's style, so the apps inside
 Basu follow it too.
 */
enum Appearance: String, CaseIterable, Identifiable {
  case system, light, dark

  static let key = "appearance"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .system: "Систем"
    case .light: "Цайвар"
    case .dark: "Бараан"
    }
  }

  var style: UIUserInterfaceStyle {
    switch self {
    case .system: .unspecified
    case .light: .light
    case .dark: .dark
    }
  }

  static var stored: Appearance {
    UserDefaults.standard.string(forKey: key).flatMap(Appearance.init(rawValue:)) ?? .system
  }

  /// Every window of the app, the one a sheet is in as well.
  @MainActor func apply() {
    for scene in UIApplication.shared.connectedScenes {
      guard let scene = scene as? UIWindowScene else { continue }
      for window in scene.windows { window.overrideUserInterfaceStyle = style }
    }
  }
}

/**
 The three choices as three small screens — the ground, a card, a line of
 ink, the accent — drawn with the real tokens in the scheme each one names.
 «Систем» is half of each, split on the diagonal.
 */
struct AppearancePicker: View {
  @Binding var selection: Appearance

  var body: some View {
    HStack(spacing: 10) {
      ForEach(Appearance.allCases) { choice in
        let chosen = choice == selection
        Button {
          selection = choice
        } label: {
          VStack(spacing: 8) {
            preview(choice)
              .frame(height: 64)
              .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                  .strokeBorder(chosen ? Color.accent : Color.line, lineWidth: chosen ? 2 : BasuMetric.hairline),
              )
            Text(choice.title)
              .font(.sans(13, chosen ? .semibold : .regular))
              .foregroundStyle(chosen ? Color.ink : Color.ink2)
          }
          .frame(maxWidth: .infinity)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(choice.title)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
        .accessibilityIdentifier("settings.appearance.\(choice.rawValue)")
      }
    }
    .sensoryFeedback(.selection, trigger: selection)
  }

  @ViewBuilder private func preview(_ choice: Appearance) -> some View {
    switch choice {
    case .light:
      Miniature().environment(\.colorScheme, .light)
    case .dark:
      Miniature().environment(\.colorScheme, .dark)
    case .system:
      ZStack {
        Miniature().environment(\.colorScheme, .light)
        Miniature().environment(\.colorScheme, .dark)
          .mask(Diagonal())
      }
    }
  }
}

/// A screen the size of a thumbnail: ground, a card with two lines of ink, an accent pill.
private struct Miniature: View {
  var body: some View {
    ZStack(alignment: .topLeading) {
      Rectangle().fill(LinearGradient.ground)
      VStack(alignment: .leading, spacing: 5) {
        Capsule().fill(Color.ink).frame(width: 26, height: 4)
        VStack(alignment: .leading, spacing: 4) {
          Capsule().fill(Color.ink2).frame(width: 34, height: 3)
          Capsule().fill(Color.ink3).frame(width: 22, height: 3)
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Color.line, lineWidth: 0.5))
        Capsule().fill(Color.accent).frame(width: 18, height: 5)
      }
      .padding(8)
    }
  }
}

/// The lower-right half of a rectangle.
private struct Diagonal: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
    path.closeSubpath()
    return path
  }
}
