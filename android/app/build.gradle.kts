import java.util.Properties

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

// Firebase (push, and the ring of a call with the app closed) reads
// app/google-services.json, which git does not see: the repository is
// public. Without the file the app builds as before, with no push.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

// A release is signed with the keystore named in keystore.properties, which
// git does not see. Without the file a release build is left unsigned.
val keystore = Properties().apply {
  val file = rootProject.file("keystore.properties")
  if (file.exists()) file.inputStream().use { load(it) }
}

android {
  namespace = "mn.basu.app"
  compileSdk = 35

  defaultConfig {
    applicationId = "mn.basu.app"
    minSdk = 26
    targetSdk = 35
    // In step with the iOS build (ios/project.yml).
    versionCode = 9
    versionName = "1.0.5"
    // Where a debug build finds the API when it is not the pilot:
    // `./gradlew installDebug -PBASU_API=http://10.0.2.2:3000`. Release ignores it.
    buildConfigField("String", "BASU_API", "\"${(project.findProperty("BASU_API") as String?) ?: ""}\"")
  }

  signingConfigs {
    if (keystore.containsKey("storeFile")) {
      create("release") {
        storeFile = rootProject.file(keystore.getProperty("storeFile"))
        storePassword = keystore.getProperty("storePassword")
        keyAlias = keystore.getProperty("keyAlias")
        keyPassword = keystore.getProperty("keyPassword")
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      signingConfig = signingConfigs.findByName("release")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures {
    compose = true
    buildConfig = true
  }
}

dependencies {
  implementation(platform("androidx.compose:compose-bom:2024.12.01"))
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.foundation:foundation")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
  implementation("androidx.lifecycle:lifecycle-process:2.8.7")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
  // The apps inside the shell are web pages (ServiceView).
  implementation("androidx.webkit:webkit:1.12.1")
  // Google's round trip runs in the system's own browser tab.
  implementation("androidx.browser:browser:1.8.0")
  // The app lock: fingerprint, face or the phone's own code.
  implementation("androidx.biometric:biometric:1.1.0")
  // The animal's photograph on an order card.
  implementation("io.coil-kt:coil-compose:2.7.0")

  // The rating ask, after something went right (ReviewMoment).
  implementation("com.google.android.play:review-ktx:2.0.2")
  // Google's WebRTC, built for Android: calls between a guest and a supplier
  // (calls/). Pinned, the same reason as iOS's: a WebRTC that moves under a
  // release is a call that stops connecting.
  implementation("io.getstream:stream-webrtc-android:1.3.10")
  // Push: order news in the tray, and a call's ring with the app closed (push/).
  implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
  implementation("com.google.firebase:firebase-messaging")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20240303")
}
