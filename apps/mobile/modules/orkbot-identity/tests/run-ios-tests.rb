#!/usr/bin/env ruby
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

require 'xcodeproj'
require 'fileutils'
require 'tmpdir'

device = ARGV.fetch(0) { abort 'Usage: ruby run-ios-tests.rb <simulator-uuid> [output-directory]' }
abort 'A simulator UUID is required' unless device.match?(/\A[0-9a-f-]{36}\z/i)
parent = ARGV[1] || Dir.tmpdir
FileUtils.mkdir_p(parent)
root = Dir.mktmpdir('ork-personal-tests-', parent)
source = File.expand_path('..', __dir__)
File.write(root + '/App.swift', <<~SWIFT)
  import SwiftUI
  @main struct IdentityTestHost: App {
    var body: some Scene { WindowGroup { Color.clear } }
  }
SWIFT
File.write(root + '/Test.entitlements', <<~PLIST)
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
  <key>application-identifier</key><string>TESTONLY01.$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>keychain-access-groups</key><array><string>TESTONLY01.$(PRODUCT_BUNDLE_IDENTIFIER)</string></array>
  <key>get-task-allow</key><true/>
  </dict></plist>
PLIST
project = Xcodeproj::Project.new(root + '/PersonalIdentity.xcodeproj')
app = project.new_target(:application, 'IdentityTestHost', :ios, '16.4')
tests = project.new_target(:unit_test_bundle, 'IdentityTests', :ios, '16.4')
app.add_file_references([project.main_group.new_file(root + '/App.swift')])
tests.add_file_references([project.main_group.new_file(source + '/ios/PersonalDeviceStore.swift'), project.main_group.new_file(source + '/tests/PersonalDeviceStoreTests.swift')])
tests.add_dependency(app)
[app, tests].each do |target|
  target.build_configurations.each do |configuration|
    settings = configuration.build_settings
    settings['SWIFT_VERSION'] = '5.0'
    settings['GENERATE_INFOPLIST_FILE'] = 'YES'
    settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'run.orkbot.identity.' + target.name.downcase
    settings['CODE_SIGN_IDENTITY'] = '-'
    settings['CODE_SIGN_STYLE'] = 'Manual'
    settings['DEVELOPMENT_TEAM'] = 'TESTONLY01'
    settings['SUPPORTED_PLATFORMS'] = 'iphonesimulator'
    settings['CODE_SIGN_ENTITLEMENTS'] = root + '/Test.entitlements'
  end
end
app.build_configurations.each do |c|
  c.build_settings['INFOPLIST_KEY_UILaunchScreen_Generation'] = 'YES'
  c.build_settings['INFOPLIST_KEY_UIApplicationSceneManifest_Generation'] = 'YES'
end
tests.build_configurations.each do |c|
  c.build_settings['TEST_HOST'] = '$(BUILT_PRODUCTS_DIR)/IdentityTestHost.app/IdentityTestHost'
  c.build_settings['BUNDLE_LOADER'] = '$(TEST_HOST)'
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(tests)
scheme.add_test_target(tests)
scheme.set_launch_target(app)
scheme.save_as(project.path, 'IdentityTests', true)

# CocoaPods provides xcodeproj. The host uses its own isolated Keychain access group.
result = system('xcodebuild', '-project', project.path.to_s, '-scheme', 'IdentityTests',
  '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', "id=#{device}",
  '-derivedDataPath', root + '/Derived', '-resultBundlePath', root + '/Results.xcresult',
  '-parallel-testing-enabled', 'NO', 'test')
puts "Native identity test results: #{root}/Results.xcresult"
exit(result ? 0 : 1)
