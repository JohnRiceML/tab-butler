import AppKit
import SwiftUI

/// Menubar agent: a status-bar item whose click opens a SwiftUI popover. Runs as
/// an accessory app (no Dock icon). Built as a plain SwiftPM executable so it
/// compiles and runs with `swift run` — no Xcode project required.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var timer: Timer?
    private let model = StatsModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "rectangle.3.group", accessibilityDescription: "Tab Butler")
            button.imagePosition = .imageLeading
            button.title = " …"
            button.target = self
            button.action = #selector(togglePopover)
        }

        popover.behavior = .transient
        popover.contentSize = NSSize(width: 360, height: 460)
        popover.contentViewController = NSHostingController(rootView: ContentView(model: model))

        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func refresh() {
        model.refresh { [weak self] in
            self?.statusItem.button?.title = " " + (self?.model.menubarTitle ?? "—")
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
