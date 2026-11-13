# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

Pod::Spec.new do |s|
  s.name = 'OrkTransport'
  s.version = '0.1.0'
  s.summary = 'Pinned installation HTTP transport'
  s.author = 'Ork contributors'
  s.homepage = 'https://ork.run'
  s.license = { :type => 'PolyForm-Noncommercial-1.0.0' }
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'SystemConfiguration'
  s.libraries = 'c++', 'resolv'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = 'ios/**/*.swift', 'generated/apple/Sources/**/*.swift'
  s.vendored_frameworks = 'generated/apple/OrkInstallationTransport.xcframework'
end
