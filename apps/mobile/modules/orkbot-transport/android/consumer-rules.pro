# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

# JNA's Android AAR retains unused desktop AWT signatures. Keep other missing-class checks.
-dontwarn java.awt.Component
-dontwarn java.awt.GraphicsEnvironment
-dontwarn java.awt.HeadlessException
-dontwarn java.awt.Window
# JNI and reflection resolve JNA's classes and members by their original names.
-keep class com.sun.jna.** { *; }
-keep class org.rustls.platformverifier.** { *; }
-keep class uniffi.ork_installation_transport.** { *; }
-keepclasseswithmembernames,includedescriptorclasses class com.orkbot.transport.OrkTransportModule {
  native <methods>;
}
