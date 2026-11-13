# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-keep class org.rustls.platformverifier.** { *; }
-keep class uniffi.ork_installation_transport.** { *; }
-keepclasseswithmembernames,includedescriptorclasses class com.orkbot.transport.OrkTransportModule {
  native <methods>;
}
