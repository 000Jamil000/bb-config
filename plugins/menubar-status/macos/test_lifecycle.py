#!/usr/bin/env python3
"""Native lifecycle smoke test; uses a temporary app, leaves BB Desktop running."""
from pathlib import Path
import subprocess,tempfile,plistlib
source=Path(__file__).with_name('BBStatus.swift').read_text()
with tempfile.TemporaryDirectory(prefix='bb-menu-test-') as directory:
 root=Path(directory); fixture=root/'Fixture.app'; contents=fixture/'Contents'; binary=contents/'MacOS/fixture'; binary.parent.mkdir(parents=True)
 with (contents/'Info.plist').open('wb') as f: plistlib.dump({'CFBundleIdentifier':'dev.bb.menubar.lifecycle-fixture','CFBundleExecutable':'fixture','CFBundleName':'Lifecycle Fixture','CFBundlePackageType':'APPL','LSUIElement':True},f)
 fake=root/'Fixture.swift'; fake.write_text('import AppKit\nlet app = NSApplication.shared\napp.setActivationPolicy(.accessory)\napp.run()\n')
 subprocess.run(['swiftc',str(fake),'-o',str(binary)],check=True)
 harness=root/'Harness.swift'
 code=source[:source.index('let app = NSApplication.shared')].replace('"dev.bb.desktop"','"dev.bb.menubar.lifecycle-fixture"')
 code+='''
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = Controller()
controller.start()
func waitFor(_ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(8)
    while !condition() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
    precondition(condition(), "lifecycle transition timed out")
}
precondition(!controller.item.isVisible, "must be hidden without BB")
let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
for _ in 0..<2 {
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    NSWorkspace.shared.openApplication(at: fixture, configuration: config) { _, error in precondition(error == nil) }
    waitFor { controller.item.isVisible }
    let running = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "dev.bb.menubar.lifecycle-fixture" }!
    precondition(running.terminate())
    waitFor { !controller.item.isVisible }
    precondition(!controller.popover.isShown)
}
print("PASS: hidden at startup, shown on launch, hidden on quit, shown on relaunch, hidden on second quit")
'''
 harness.write_text(code)
 exe=root/'Harness'; subprocess.run(['swiftc',str(harness),'-o',str(exe)],check=True)
 subprocess.run([str(exe),str(fixture)],check=True,timeout=45)
