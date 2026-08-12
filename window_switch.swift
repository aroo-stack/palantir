// Permission-free next/previous app switcher.
// Lists on-screen windows (front-to-back z-order), walks the visible apps,
// finds the current frontmost app, and activates the next/previous one —
// mirroring ⌘⇥ / ⌘⇧⇥. Uses only CoreGraphics + AppKit: no System Events,
// no Accessibility, no Automation permission needed.
//
// Usage: window_switch next | prev
import Cocoa
import Foundation

guard CommandLine.arguments.count >= 2 else { exit(2) }
let direction = CommandLine.arguments[1]

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
    if app.localizedName == nil { continue }
    seen.insert(pid_t(pid))
    orderedApps.append(app)
}

let front = NSWorkspace.shared.frontmostApplication
guard let front, let frontPid = front.processIdentifier as pid_t?,
      let frontIdx = orderedApps.firstIndex(where: { $0.processIdentifier == frontPid }) else { exit(0) }

guard orderedApps.count >= 2 else { exit(0) }
var targetIdx = direction == "prev" ? frontIdx - 1 : frontIdx + 1
if targetIdx < 0 { targetIdx = orderedApps.count - 1 }
if targetIdx >= orderedApps.count { targetIdx = 0 }

let target = orderedApps[targetIdx]
_ = target.activate(options: [.activateIgnoringOtherApps])
print(target.localizedName ?? "")
exit(0)
