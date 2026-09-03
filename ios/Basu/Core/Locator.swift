import CoreLocation
import Observation

/**
 Where the guest is, while they are looking at their order.

 Foreground only, and only while the status screen is up. The product's own
 measurement of "is this person actually coming" is the arm answer and the two
 geofence bands; asking for always-on location to get a slightly earlier band
 would be a much larger promise than the app needs to make.
 */
@MainActor
@Observable
final class Locator: NSObject, CLLocationManagerDelegate {
  private let manager = CLLocationManager()

  private(set) var here: CLLocationCoordinate2D?
  private(set) var permission: CLAuthorizationStatus

  override init() {
    permission = manager.authorizationStatus
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    // Fifty metres is finer than the bands need and coarse enough that a walk
    // across town is not a hundred wake-ups.
    manager.distanceFilter = 50
  }

  func start() {
    if manager.authorizationStatus == .notDetermined {
      manager.requestWhenInUseAuthorization()
    }
    manager.startUpdatingLocation()
  }

  func stop() {
    manager.stopUpdatingLocation()
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let last = locations.last else { return }
    let lat = last.coordinate.latitude
    let lon = last.coordinate.longitude
    Task { @MainActor in
      self.here = CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
  }

  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    Task { @MainActor in
      self.permission = status
      if status == .authorizedWhenInUse || status == .authorizedAlways {
        self.start()
      }
    }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // A fix that never arrives is normal indoors. The walk falls back to the
    // restaurant's own estimate and the bands simply never fire.
  }
}

/**
 The two rings around a restaurant.

 800 metres is roughly ten minutes' walk and 300 is the last block — far enough
 out to still be worth re-planning around, close enough in to be certain. A
 band is news once: a guest pacing outside the door is not a new signal every
 fifty metres.
 */
enum Geofence {
  static func band(metres: Double) -> String? {
    if metres <= 300 { return "geofence_300" }
    if metres <= 800 { return "geofence_800" }
    return nil
  }
}

extension CLLocationCoordinate2D {
  /// Metres between two coordinates. The same haversine the web app uses, so
  /// the band a phone reports does not depend on which client it came from.
  func metres(to other: CLLocationCoordinate2D) -> Double {
    CLLocation(latitude: latitude, longitude: longitude)
      .distance(from: CLLocation(latitude: other.latitude, longitude: other.longitude))
  }
}
