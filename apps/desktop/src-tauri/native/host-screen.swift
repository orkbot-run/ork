// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import AppKit
import ApplicationServices
import Darwin
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// The public mouse event constructor carries the window number. The window-local
// point also needs stamping on current macOS so AppKit can hit-test the target.
// Resolve this SPI at runtime and decline control if the system no longer exports it.
typealias SetWindowLocation = @convention(c) (CGEvent, Double, Double) -> Void
let setWindowLocation = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation")
    .map { unsafeBitCast($0, to: SetWindowLocation.self) }

// The helper receives JSON on stdin, never source code or shell arguments.
// Capture uses a window filter: overlapping windows from other apps cannot leak into a frame.
struct ScreenFailure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw ScreenFailure(message: message) }
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
}
func permission(_ prompt: Bool) -> Bool {
    let accessibility = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
    let capture = CGPreflightScreenCaptureAccess()
    if prompt && !capture { _ = CGRequestScreenCaptureAccess() }
    return accessibility && capture
}

@available(macOS 14.0, *)
@MainActor
func run(_ request: [String: Any]) async throws -> [String: Any] {
    let method = request["method"] as? String ?? ""
    if method == "permissions" { return ["screen": permission(true)] }
    if method == "capabilities" {
        let ready = permission(false)
        return ["screen": ready, "control": ready && setWindowLocation != nil]
    }
    guard permission(false) else {
        try fail(
            "Allow Screen Recording and Accessibility for Ork in System Settings, then enable access again.")
    }
    guard let name = request["app"] as? String, !name.isEmpty else {
        try fail("Name the approved application.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    // Resolve an exact visible app name; ambiguous names must never select an arbitrary process.
    let applications = content.applications.filter {
        $0.applicationName.caseInsensitiveCompare(name) == .orderedSame
    }
    guard applications.count == 1, let application = applications.first else {
        try fail("The approved application is not open or its name is ambiguous.")
    }
    let windows = content.windows.filter {
        $0.owningApplication?.processID == application.processID && $0.windowLayer == 0 && $0.frame.width > 0
            && $0.frame.height > 0
    }
    guard let window = windows.first else { try fail("The approved application has no visible window.") }
    let frame = window.frame
    guard frame.width <= 20000, frame.height <= 20000, frame.width * frame.height <= 16_000_000 else {
        try fail("The approved application window is too large to capture.")
    }
    let pid = application.processID
    func checkTarget() throws {
        guard let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated,
            running.localizedName?.caseInsensitiveCompare(name) == .orderedSame
        else { try fail("The approved application closed. Observe it again.") }
    }
    func point(_ action: [String: Any]) throws -> CGPoint {
        guard let x = action["x"] as? Double, let y = action["y"] as? Double,
            x.isFinite, y.isFinite, x >= 0, y >= 0, x < frame.width, y < frame.height
        else { try fail("Coordinates must be inside the approved window.") }
        return CGPoint(x: frame.minX + x, y: frame.minY + y)
    }
    func post(_ event: CGEvent?) throws {
        try checkTarget()
        guard let event else { try fail("Could not create an input event.") }
        switch event.type {
        case .mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .scrollWheel:
            guard let setWindowLocation else {
                try fail("Window-targeted pointer control is unavailable on this macOS version.")
            }
            let point = event.location
            setWindowLocation(event, point.x - frame.minX, point.y - frame.minY)
            if event.type == .scrollWheel, let windowField = CGEventField(rawValue: 51) {
                // Unlike the AppKit pointer constructor, the wheel constructor has no window argument.
                event.setIntegerValueField(windowField, value: Int64(window.windowID))
            }
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowID))
            event.setIntegerValueField(
                .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowID))
        default:
            break
        }
        event.postToPid(pid)
    }
    func mouse(_ type: NSEvent.EventType, _ screenPoint: CGPoint, _ count: Int) throws {
        let windowPoint = CGPoint(x: screenPoint.x - frame.minX, y: frame.maxY - screenPoint.y)
        let event = NSEvent.mouseEvent(
            with: type, location: windowPoint, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: Int(window.windowID), context: nil, eventNumber: 0,
            clickCount: count, pressure: type == .leftMouseDown || type == .rightMouseDown ? 1 : 0
        )
        let routed = event?.cgEvent
        routed?.location = screenPoint
        try post(routed)
    }
    var completed = 0
    do {
        if method == "screenAct" {
            guard let actions = request["actions"] as? [[String: Any]], !actions.isEmpty, actions.count <= 24
            else { try fail("Invalid screen actions.") }
            for action in actions {
                try checkTarget()
                let kind = action["kind"] as? String ?? ""
                switch kind {
                case "click", "move":
                    let p = try point(action)
                    let right = action["button"] as? String == "right"
                    if kind == "move" {
                        try mouse(.mouseMoved, p, 0)
                    } else {
                        for count in 1...(action["double"] as? Bool == true ? 2 : 1) {
                            try mouse(right ? .rightMouseDown : .leftMouseDown, p, count)
                            try mouse(right ? .rightMouseUp : .leftMouseUp, p, count)
                        }
                    }
                case "type":
                    guard let text = action["text"] as? String, text.utf16.count <= 10000 else {
                        try fail("Invalid text.")
                    }
                    // Keep each event bounded without splitting a UTF-16 surrogate pair.
                    for scalar in text.unicodeScalars {
                        let units = Array(String(scalar).utf16)
                        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
                        down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                        try post(down)
                        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
                        up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                        try post(up)
                    }
                case "key":
                    let keys: [String: CGKeyCode] = [
                        "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53,
                        "esc": 53, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
                        "left": 123, "right": 124, "down": 125, "up": 126, "a": 0, "s": 1, "d": 2, "f": 3,
                        "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
                        "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
                        "k": 40, "n": 45, "m": 46,
                    ]
                    guard let key = action["key"] as? String, let code = keys[key.lowercased()] else {
                        try fail("Unsupported key.")
                    }
                    let flags: [String: CGEventFlags] = [
                        "cmd": .maskCommand, "ctrl": .maskControl, "shift": .maskShift,
                        "option": .maskAlternate,
                    ]
                    var modifiers = CGEventFlags()
                    for modifier in action["modifiers"] as? [String] ?? [] {
                        guard let flag = flags[modifier] else { try fail("Unsupported key modifier.") }
                        modifiers.insert(flag)
                    }
                    for pressed in [true, false] {
                        let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: pressed)
                        event?.flags = modifiers
                        try post(event)
                    }
                case "scroll":
                    guard let direction = action["direction"] as? String,
                        ["up", "down", "left", "right"].contains(direction)
                    else { try fail("Invalid scroll direction.") }
                    let amount = action["amount"] as? Int ?? 3
                    guard amount > 0, amount <= 20 else { try fail("Invalid scroll amount.") }
                    let event = CGEvent(
                        scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                        wheel1: direction == "up" ? Int32(amount) : direction == "down" ? -Int32(amount) : 0,
                        wheel2: direction == "left"
                            ? Int32(amount) : direction == "right" ? -Int32(amount) : 0, wheel3: 0)
                    if action["x"] != nil || action["y"] != nil {
                        event?.location = try point(action)
                    } else {
                        event?.location = CGPoint(x: frame.midX, y: frame.midY)
                    }
                    try post(event)
                case "wait":
                    let ms = action["ms"] as? Int ?? -1
                    guard ms >= 0, ms <= 5000 else { try fail("Invalid wait duration.") }
                    try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
                default:
                    try fail(
                        "This action requires an accessibility element driver. Use window coordinates or keys."
                    )
                }
                completed += 1
            }
        } else if method != "screenObserve" {
            try fail("Invalid screen method.")
        }
        if completed > 0 { try await Task.sleep(nanoseconds: 100_000_000) }
        try checkTarget()
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(frame.width)
        configuration.height = Int(frame.height)
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: configuration)
        try checkTarget()
        let bytes = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                bytes, UTType.jpeg.identifier as CFString, 1, nil)
        else { try fail("Could not encode the approved window.") }
        CGImageDestinationAddImage(
            destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            try fail("Could not encode the approved window.")
        }
        let observation: [String: Any] = [
            "app": name, "title": window.title ?? "",
            "tree": "Approved application window. Coordinates use this image's pixels.",
            "image": [
                "mimeType": "image/jpeg", "data": (bytes as Data).base64EncodedString(), "width": image.width,
                "height": image.height,
            ],
        ]
        return method == "screenAct" ? ["completed": completed, "observation": observation] : observation
    } catch {
        guard method == "screenAct" else { throw error }
        return [
            "completed": completed,
            "error": (error as? ScreenFailure)?.message
                ?? "Could not capture the window after input. Observe it again.",
        ]
    }
}

@main struct HostScreenMain {
    @MainActor
    static func main() async {
        // ScreenCaptureKit window filters require an initialized AppKit/WindowServer client.
        // A command-line helper does not establish that connection automatically.
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        do {
            let bytes = FileHandle.standardInput.readDataToEndOfFile()
            guard bytes.count <= 1024 * 1024,
                let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
            else { try fail("Invalid screen request.") }
            if #available(macOS 14.0, *) {
                emit(try await run(request))
            } else {
                emit(["error": "Local screen control requires macOS 14 or newer."])
            }
        } catch let error as ScreenFailure { emit(["error": error.message]) } catch {
            emit([
                "error":
                    "The approved application could not be captured or controlled. Check its permissions and observe again."
            ])
        }
    }
}
