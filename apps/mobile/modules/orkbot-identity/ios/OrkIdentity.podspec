# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

Pod::Spec.new do |s|
  s.name = 'OrkIdentity'
  s.version = '0.1.0'
  s.summary = 'Device-bound personal workspace credentials'
  s.author = 'Ork contributors'
  s.homepage = 'https://ork.run'
  s.license = { :type => 'PolyForm-Noncommercial-1.0.0' }
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
