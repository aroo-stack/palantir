// Permission-free next/previous app switcher.
// Lists on-screen windows (front-to-back z-order), walks the visible apps,
// and activates the next/previous app relative to the CALLING app (the
// tracker itself) — not `NSWorkspace.frontmostApplication`, which is
// unreliable from a background-spawned helper on a fullscreen Space.
// Counterpart mirrors ⌘⇥ / ⌘⇧⇥. Uses only CoreGraphics + AppKit: no
// System Events, no Accessibility, no Automation permission needed.
//
// Ordering: on-screen windows (front→back) first, then any remaining running
// regular (non-dock, non-background) apps not already listed, so the switcher
// always has candidates even if only one window is visible on the current Space.
//
// Usage: window_switch next|prev <selfPid>
import Cocoa
import Foundation

guard CommandLine.arguments.count >= 3 else { exit(2) }
let direction = CommandLine.arguments[1]
guard let selfPid = pid_t(CommandLine.arguments[2]) else { exit(2) }

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(2) }

var orderedApps: [NSRunningApplication] = []
var seen = Set<pid_t>()
for w in raw {
    let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
    if layer != 0 { continue }
    let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
    if pid <= 0 || seen.contains(pid_t(pid)) { continue }
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { continue }
    guard app.localizedName != nil else { continue }
    seen.insert(pid_t(pid))
    orderedApps.append(app)
}

// Always guarantee a switchable set: append every other running regular app
// (Cmd-Tab style), preserving the visible z-order at the front of the list.
for app in NSWorkspace.shared.runningApplications {
    if app.activationPolicy != .regular { continue }
    let pid = app.processIdentifier as pid_t
    if seen.contains(pid) { continue }
    guard app.localizedName != nil else { continue }
    seen.insert(pid)
    orderedApps.append(app)
}

guard orderedApps.count >= 2 else { exit(0) }
guard let selfIdx = orderedApps.firstIndex(where: { $0.processIdentifier == selfPid }) else { exit(0) }

var targetIdx = direction == "prev" ? selfIdx - 1 : selfIdx + 1
if targetIdx < 0 { targetIdx = orderedApps.count - 1 }
if targetIdx >= orderedApps.count { targetIdx = 0 }

let target = orderedApps[targetIdx]
_ = target.activate(options: [.activateAllWindows])
print(target.bundleIdentifier ?? "", target.localizedName ?? "")
exit(0)