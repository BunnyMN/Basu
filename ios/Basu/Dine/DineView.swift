import MapKit
import SwiftUI

/**
 The dine-in app: a map, because the product is "which lunch is fifteen minutes
 away", and that is a question about a place before it is one about a menu.

 Everything else happens in a sheet over it. A guest walking to a restaurant
 wants the progress and the route at the same time, so the status is a sheet
 rather than a screen instead of the map.
 */
struct DineView: View {
  /// Set when the home screen sent somebody straight to an order they have.
  let resuming: String?

  @Environment(AppModel.self) private var app
  @Environment(Session.self) private var session
  @Environment(\.dismiss) private var dismiss

  @State private var model: DineModel?
  @State private var locator = Locator()
  @State private var camera: MapCameraPosition = .region(
    MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 47.9184, longitude: 106.9177),
      span: MKCoordinateSpan(latitudeDelta: 0.045, longitudeDelta: 0.045),
    ),
  )
  @State private var signingIn = false

  var body: some View {
    Group {
      if let model {
        content(model)
      } else {
        Color.bg.overlay(ProgressView())
      }
    }
    .task {
      let fresh = model ?? DineModel(app: app)
      model = fresh
      await fresh.loadVenues()
      await fresh.resume(resuming)
      locator.start()
    }
    .onDisappear { locator.stop() }
  }

  @ViewBuilder
  private func content(_ model: DineModel) -> some View {
    @Bindable var model = model

    ZStack(alignment: .topLeading) {
      Map(position: $camera) {
        ForEach(model.venues) { venue in
          if let coordinate = venue.coordinate {
            Annotation(venue.name, coordinate: coordinate) {
              VenuePin(open: venue.acceptingOrders)
                .onTapGesture { Task { await model.open(venue) } }
                .accessibilityIdentifier("pin.\(venue.name)")
            }
          }
        }

        if let walk = model.walk {
          MapPolyline(coordinates: walk.coordinates)
            .stroke(
              Color.route,
              style: StrokeStyle(
                lineWidth: 5,
                lineCap: .round,
                lineJoin: .round,
                // A guess is drawn dashed, so it never looks surveyed.
                dash: walk.isGuess ? [2, 9] : [],
              ),
            )
        }

        UserAnnotation()
      }
      .mapControls {
        MapUserLocationButton()
        MapCompass()
      }
      .ignoresSafeArea(edges: .bottom)

      VStack(alignment: .leading, spacing: 8) {
        badge(model)
        if model.offline {
          OfflineBanner { await app.retry() }
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 4))
        }
      }
      .padding(12)
    }
    .safeAreaInset(edge: .top) { DemoClockBar() }
    .safeAreaInset(edge: .bottom) {
      if model.orderId != nil, model.sheet == nil, let order = model.order {
        OrderBar(order: order) { model.sheet = .status }
      }
    }
    .navigationTitle("Хоол")
    .navigationBarTitleDisplayMode(.inline)
    // The way back says where it goes. The system's own chevron says "Back",
    // which is true and useless — this app is one icon inside Basu and the
    // control should name the place it returns to.
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button { dismiss() } label: {
          HStack(spacing: 2) {
            Image(systemName: "chevron.left")
            Text("Basu").font(.system(size: 15, weight: .semibold))
          }
        }
        .accessibilityIdentifier("dine.home")
      }
    }
    // One sheet whose content changes, not two sheets that take turns. Paying
    // turns a menu into a status while the sheet is up, and asking SwiftUI to
    // swap one presentation for another in the same breath leaves the screen
    // with neither.
    .sheet(isPresented: Binding(
      get: { model.sheet != nil },
      set: { if !$0 { model.sheet = nil } },
    )) {
      DineSheet(model: model, signingIn: $signingIn)
    }
    .sheet(isPresented: $signingIn) { SignInSheet() }
    .task(id: locator.here?.latitude) { await model.located(at: locator.here) }
    .task {
      // The kitchen accepts, fires and plates without the guest touching
      // anything, so the screen keeps asking. Four seconds is the same beat
      // the web app uses.
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(4))
        if model.orderId != nil {
          await model.refreshStatus()
        } else {
          await model.loadVenues()
        }
      }
    }
    .overlay(alignment: .bottom) { Toast(text: model.note) }
    .onChange(of: model.note) { _, fresh in
      guard fresh != nil else { return }
      Task {
        try? await Task.sleep(for: .seconds(3.2))
        model.note = nil
      }
    }
  }

  /// What the map cannot say by itself: what this is, and whether anybody is
  /// open. A map of grey pins with no explanation is a dead end.
  private func badge(_ model: DineModel) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text("Үдийн хоол")
        .font(.system(size: 14.5, weight: .bold))
        .foregroundStyle(Color.ink)
      Text(model.venues.isEmpty
        // With nothing on the map, silence would read as "nowhere is open".
        ? (model.offline ? "Ресторануудыг ачаалж чадсангүй" : "Ирэхээс чинь өмнө гал тавина")
        : model.openVenueCount > 0
          ? "\(model.openVenueCount)/\(model.venues.count) ресторан захиалга авч байна"
          : "Нэг ч гал тогоо холбогдоогүй")
        .font(.mono(10.5))
        .foregroundStyle(Color.ink3)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(Color.surface, in: RoundedRectangle(cornerRadius: 3))
    .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.line, lineWidth: 1))
    .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
  }
}

/// What is in the sheet right now.
///
/// A view of its own rather than a `switch` in the presentation closure: the
/// closure is evaluated when the sheet opens, so a change of mind inside it
/// goes unnoticed, while a view's body is re-run whenever what it reads
/// changes. That difference is the whole reason paying used to close the sheet
/// instead of turning it into a status.
struct DineSheet: View {
  @Bindable var model: DineModel
  @Binding var signingIn: Bool

  var body: some View {
    if model.sheet == .status {
      StatusSheet(model: model)
    } else {
      VenueSheet(model: model, signingIn: $signingIn)
    }
  }
}

/// A pin. Open kitchens are the accent colour; a kitchen nobody is watching is
/// grey and struck through, because it cannot take an order.
struct VenuePin: View {
  let open: Bool

  var body: some View {
    ZStack {
      Circle()
        .fill(open ? Color.accent : Color.ink3)
        .frame(width: 26, height: 26)
        .overlay(Circle().stroke(.white, lineWidth: 2))
        .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
      BowlGlyph()
        .stroke(.white, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        .frame(width: 15, height: 15)
        .opacity(open ? 1 : 0.65)
    }
  }
}

/// The bar left behind when the status sheet is dismissed: the same answer in
/// one line, and the way back to the detail.
struct OrderBar: View {
  let order: OrderDetail
  let tap: () -> Void

  var body: some View {
    Button(action: tap) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text("№\(order.code)")
            .font(.mono(11))
            .foregroundStyle(Color.ink3)
          Text(order.state.subtitle ?? order.state.word)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Color.ink)
        }
        Spacer()
        Text(order.state.word)
          .font(.mono(13, .semibold))
          .foregroundStyle(order.state.tint)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(.regularMaterial)
      .overlay(alignment: .top) { Divider() }
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("orderbar")
  }
}

/// A line that says what just happened and then gets out of the way.
struct Toast: View {
  let text: String?

  var body: some View {
    if let text {
      Text(text)
        .font(.system(size: 13))
        .foregroundStyle(Color.bg)
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(Color.ink, in: RoundedRectangle(cornerRadius: 3))
        .padding(.bottom, 90)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
  }
}
