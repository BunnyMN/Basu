import SwiftUI

/**
 Signing in: a phone number and a six-digit code, no password.

 The code goes out by SMS and is never in a response body — which is right, and
 which means a demo running against a fake gateway has no way to read it. So a
 debug build carries one extra button that goes straight to a session. It is
 compiled out of anything shipped.
 */
struct SignInSheet: View {
  @Environment(Session.self) private var session
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  @State private var phone = "+976"
  @State private var code = ""
  @State private var codeSent = false
  @State private var busy = false
  @State private var trouble: String?

  var body: some View {
    NavigationStack {
      Form {
        if session.isSignedIn {
          Section {
            LabeledContent("Утас", value: session.phone ?? "—")
            Button("Гарах", role: .destructive) {
              session.signOut()
              Task { await model.refreshLive() }
              dismiss()
            }
          } footer: {
            Text("Гарсан ч захиалга чинь хэвээр. Дахин нэвтэрвэл гарч ирнэ.")
          }
        } else {
          Section {
            TextField("+97699001122", text: $phone)
              .keyboardType(.phonePad)
              .textContentType(.telephoneNumber)
              .font(.mono(16))
              .accessibilityIdentifier("signin.phone")
            if codeSent {
              TextField("6 оронтой код", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.mono(16))
                .accessibilityIdentifier("signin.code")
            }
          } header: {
            Text(codeSent ? "Мессежээр ирсэн код" : "Утасны дугаар")
          } footer: {
            Text(codeSent
              ? "Код таны утас руу мессежээр очлоо."
              : "Нууц үг байхгүй. Нэг удаагийн кодоор нэвтэрнэ.")
          }

          if let trouble {
            Section { Banner(message: trouble) }
          }

          Section {
            WideButton(
              title: codeSent ? "Нэвтрэх" : "Код авах",
              enabled: !busy && (codeSent ? code.count >= 4 : phone.count >= 12),
            ) {
              Task { await go() }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
          }

          #if DEBUG
            Section {
              Button("Демо: кодгүй нэвтрэх") {
                Task {
                  busy = true
                  defer { busy = false }
                  do {
                    try await session.demoSignIn(phone: phone.count >= 12 ? phone : "+97699001122")
                    await model.refreshLive()
                    dismiss()
                  } catch {
                    trouble = (error as? APIError)?.message ?? "Нэвтэрч чадсангүй."
                  }
                }
              }
              .font(.system(size: 14))
              .accessibilityIdentifier("signin.demo")
            } footer: {
              Text("Зөвхөн хөгжүүлэлтийн build дээр. Демо серверийн SMS хаашаа ч очдоггүй.")
            }
          #endif
        }
      }
      .navigationTitle(session.isSignedIn ? "Бүртгэл" : "Нэвтрэх")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Хаах") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
  }

  private func go() async {
    busy = true
    trouble = nil
    defer { busy = false }
    do {
      if codeSent {
        try await session.verify(phone: phone, code: code)
        await model.refreshLive()
        dismiss()
      } else {
        try await session.requestCode(phone: phone)
        codeSent = true
      }
    } catch {
      trouble = (error as? APIError)?.message ?? "Алдаа гарлаа."
    }
  }
}
