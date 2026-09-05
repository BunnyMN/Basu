import SwiftUI
import WidgetKit

@main
struct BasuWidgetBundle: WidgetBundle {
  var body: some Widget {
    OrderWidget()
    OrderLiveActivity()
  }
}
