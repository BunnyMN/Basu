import Foundation
import Testing

@testable import Basu

/**
 A number as people type it is the number the server stores.

 The server normalises too, but the sheet decides when the button lights up
 and the profile shows the number it kept — both from this.
 */
struct SignInTests {
  @Test(arguments: zip(
    ["8811 2233", "88112233", "+976 8811-2233", "976 8811 2233", "0097688112233", "(8811) 22-33"],
    Array(repeating: "+97688112233", count: 6),
  ))
  func aNumberIsTheOneTheServerStores(typed: String, stored: String) {
    #expect(PhoneNumber.e164(typed) == stored)
    #expect(PhoneNumber.looksComplete(typed))
  }

  @Test func halfANumberOrAForeignOneIsNotSent() {
    #expect(!PhoneNumber.looksComplete(""))
    #expect(!PhoneNumber.looksComplete("8811 22"))
    #expect(!PhoneNumber.looksComplete("+1 555 010 9999"))
    #expect(!PhoneNumber.looksComplete("+976 8811 2233 4"))
  }

  // MARK: Google's way back

  @Test func googleComesBackWithASessionInTheFragment() {
    let back = URL(string: "basu://auth#auth=abc-DEF_123")!
    #expect(GoogleReturn.parse(back) == .token("abc-DEF_123"))
  }

  @Test func aCancelIsQuietAndARefusalSaysWhy() {
    #expect(GoogleReturn.parse(URL(string: "basu://auth#auth_error=CANCELLED")!) == .cancelled)
    #expect(GoogleReturn.parse(URL(string: "basu://auth#auth_error=SOCIAL_CLOSED")!) == .refused("SOCIAL_CLOSED"))
    #expect(GoogleReturn.words(for: "SOCIAL_CLOSED").contains("нээгдээгүй"))
  }

  @Test func onlyOurOwnWayBackCounts() {
    // A token anywhere but in basu://auth's fragment is not one we asked for.
    #expect(GoogleReturn.parse(URL(string: "basu://order#auth=abc")!) == .refused("SOCIAL_REFUSED"))
    #expect(GoogleReturn.parse(URL(string: "https://evil.example/auth#auth=abc")!) == .refused("SOCIAL_REFUSED"))
    #expect(GoogleReturn.parse(URL(string: "basu://auth?auth=abc")!) == .refused("SOCIAL_REFUSED"))
  }

  // MARK: Apple's nonce

  @Test func theNonceIsFreshAndItsHashIsWhatTheServerChecks() {
    let one = Nonce.make()
    #expect(one != Nonce.make())
    #expect(one.count >= 40)
    // The server hashes the same way: sha256, lowercase hex.
    #expect(Nonce.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }

  // MARK: an account without a phone

  @Test func aProfileWithoutAPhoneStillReads() throws {
    let json = """
      {"id":"g1","phone":null,"email":"bat@gmail.com","display_name":"Бат","locale":"mn",
       "avatar_seed":"ab12cd34","member_since":"2026-09-24T03:00:00.000Z",
       "wallet":{"balance_mnt":0,"currency":"MNT"},"unread":0}
      """
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      ISODate.parse(try decoder.singleValueContainer().decode(String.self)) ?? .distantPast
    }
    let me = try decoder.decode(Me.self, from: Data(json.utf8))
    #expect(me.phone == nil)
    #expect(me.email == "bat@gmail.com")
  }

  @Test func anAddressIsStoredTheOneWay() {
    #expect(Session.address("  Bat@Gmail.COM \n") == "bat@gmail.com")
  }
}
