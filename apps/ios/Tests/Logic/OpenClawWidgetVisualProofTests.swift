import CoreText
import OpenClawKit
import SwiftUI
import UIKit
import WidgetKit
import XCTest

@MainActor
final class OpenClawWidgetVisualProofTests: XCTestCase {
    private struct Family {
        let name: String
        let value: WidgetFamily
        let size: CGSize
    }

    /// Fixed content canvases, not claims about the OS widget gallery's geometry.
    private static let families: [Family] = [
        Family(name: "small", value: .systemSmall, size: CGSize(width: 170, height: 170)),
        Family(name: "medium", value: .systemMedium, size: CGSize(width: 364, height: 170)),
        Family(name: "large", value: .systemLarge, size: CGSize(width: 364, height: 382)),
        Family(name: "extra-large", value: .systemExtraLarge, size: CGSize(width: 715, height: 342)),
        Family(name: "inline", value: .accessoryInline, size: CGSize(width: 234, height: 32)),
        Family(name: "circular", value: .accessoryCircular, size: CGSize(width: 76, height: 76)),
        Family(name: "rectangular", value: .accessoryRectangular, size: CGSize(width: 172, height: 76)),
    ]

    private let now = Date(timeIntervalSince1970: 100_000)

    func testHomeAndLockFamiliesWithLongLabelsAndDynamicType() throws {
        let presentation = self.presentation(
            label: String(repeating: "Long selected conversation label ", count: 5))
        for family in Self.families {
            for scheme in [ColorScheme.light, .dark] {
                for typeSize in [DynamicTypeSize.large, .accessibility5] {
                    try self.capture(
                        presentation, family: family, scheme: scheme, typeSize: typeSize, scenario: "long-label")
                }
            }
        }
    }

    func testCompactOfflineAndFactAgeRemainIndependentlyVisible() throws {
        for family in Self.families.suffix(3) {
            for scheme in [ColorScheme.light, .dark] {
                let offline = try self.capture(
                    self.presentation(availability: .offline),
                    family: family,
                    scheme: scheme,
                    scenario: "offline-recent")
                let stale = try self.capture(
                    self.presentation(age: 600),
                    family: family,
                    scheme: scheme,
                    scenario: "online-stale")
                let both = try self.capture(
                    self.presentation(age: 600, availability: .offline),
                    family: family,
                    scheme: scheme,
                    scenario: "offline-stale")
                let unknown = try self.capture(
                    self.presentation(age: nil, availability: .offline),
                    family: family,
                    scheme: scheme,
                    scenario: "offline-age-unknown")
                try self.capture(
                    self.presentation(age: nil),
                    family: family,
                    scheme: scheme,
                    scenario: "online-age-unknown")

                let staleDifference = both.differenceBounds(from: offline)
                let offlineDifference = both.differenceBounds(from: stale)
                let unknownDifference = unknown.differenceBounds(from: offline)
                XCTAssertFalse(staleDifference.isNull, "Staleness must remain visible while offline")
                XCTAssertFalse(offlineDifference.isNull, "Offline must remain visible while stale")
                XCTAssertFalse(unknownDifference.isNull, "Unknown-age facts must not look recent")
                if family.value == .accessoryCircular {
                    XCTAssertLessThan(offlineDifference.maxX, staleDifference.minX)
                    XCTAssertLessThan(offlineDifference.maxX, unknownDifference.minX)
                    XCTAssertLessThanOrEqual(staleDifference.height, 12)
                    XCTAssertLessThanOrEqual(offlineDifference.height, 12)
                    XCTAssertLessThanOrEqual(unknownDifference.height, 12)
                }
            }
        }
    }

    func testRecoveryAndPrivacyAreExposedWithoutSelectedDetails() throws {
        let cases: [(String, OpenClawWidgetPresentation, String)] = [
            ("unconfigured", self.presentation(configured: false), "Edit widget to select. No selection"),
            ("unavailable", self.presentation(availability: .unavailable), "Open OpenClaw. Unavailable"),
            (
                "permission",
                self.presentation(availability: .permissionDenied),
                "Authorize in OpenClaw. Access required"),
            ("expired", self.presentation(age: 86400), "Check in OpenClaw. Status expired"),
            ("locked", self.presentation(privacy: .locked), "Unlock to view"),
            ("hidden", self.presentation(privacy: .hidden), "Details hidden"),
        ]
        for family in Self.families.suffix(3) {
            for (scenario, presentation, accessibility) in cases {
                let pixels = try self.capture(
                    presentation,
                    family: family,
                    scheme: .dark,
                    scenario: scenario,
                    expectedAccessibility: accessibility)
                if scenario == "locked" || scenario == "hidden" {
                    let alternative = self.presentation(
                        label: "Another private label",
                        outcome: .failed,
                        privacy: scenario == "locked" ? .locked : .hidden)
                    let alternativePixels = try self.capture(
                        alternative,
                        family: family,
                        scheme: .dark,
                        scenario: "\(scenario)-other-selection",
                        expectedAccessibility: accessibility)
                    XCTAssertTrue(
                        pixels.differenceBounds(from: alternativePixels).isNull,
                        "Private labels and outcomes must not affect rendered pixels")
                }
            }
        }
    }

    private func presentation(
        label: String = "Private selected conversation",
        outcome: OpenClawWidgetSnapshot.TerminalOutcome = .completed,
        age: TimeInterval? = 0,
        privacy: OpenClawWidgetPresentation.Privacy = .visible,
        availability: OpenClawWidgetPresentation.Availability = .connected,
        configured: Bool = true) -> OpenClawWidgetPresentation
    {
        let session = OpenClawNativeSessionRef(
            owner: OpenClawNativeOwnerRef(gatewayID: "proof-gateway", profileID: "proof-profile"),
            agentID: "proof-agent",
            sessionKey: "proof-session")
        let snapshot = OpenClawWidgetSnapshot(
            subject: .run(
                OpenClawNativeRunRef(session: session, runID: "proof-run"),
                sessionID: "proof-generation",
                outcome: outcome),
            label: label,
            sourceRecordedAt: age.map { self.now.addingTimeInterval(-$0) },
            queryObservedAt: self.now)
        return OpenClawWidgetPresentation.resolve(
            snapshot: configured ? snapshot : nil,
            now: self.now,
            staleAfter: 300,
            expiresAfter: 86400,
            privacy: privacy,
            availability: availability)
    }

    @discardableResult
    private func capture(
        _ presentation: OpenClawWidgetPresentation,
        family: Family,
        scheme: ColorScheme,
        typeSize: DynamicTypeSize = .large,
        scenario: String,
        expectedAccessibility: String? = nil) throws -> Pixels
    {
        try self.registerFonts()
        let name = try self.attachmentName(scenario: scenario, family: family, scheme: scheme, typeSize: typeSize)
        let root = OpenClawStatusWidgetContent(presentation: presentation, family: family.value)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, typeSize)
            .environment(\.locale, Locale(identifier: "en_US"))
        let hosting = UIHostingController(rootView: root)
        hosting.safeAreaRegions = []
        let fitted = hosting.sizeThatFits(in: family.size)
        XCTAssertLessThanOrEqual(fitted.width, family.size.width + 0.5, name)
        XCTAssertLessThanOrEqual(fitted.height, family.size.height + 0.5, name)

        // The unpainted gutter reveals content escaping its allotted canvas.
        let gutter: CGFloat = 8
        let canvas = CGSize(width: family.size.width + gutter * 2, height: family.size.height + gutter * 2)
        let contentFrame = CGRect(origin: CGPoint(x: gutter, y: gutter), size: family.size)
        let container = UIViewController()
        container.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        container.view.backgroundColor = .systemBackground
        let window = UIWindow(frame: CGRect(origin: .zero, size: canvas))
        defer {
            container.beginAppearanceTransition(false, animated: false)
            container.endAppearanceTransition()
            hosting.willMove(toParent: nil)
            hosting.view.removeFromSuperview()
            hosting.removeFromParent()
            window.resignKey()
            window.isHidden = true
            window.rootViewController = nil
        }
        window.rootViewController = container
        container.addChild(hosting)
        container.view.addSubview(hosting.view)
        hosting.view.backgroundColor = .clear
        hosting.view.frame = contentFrame
        hosting.didMove(toParent: container)
        container.beginAppearanceTransition(true, animated: false)
        window.makeKeyAndVisible()
        container.endAppearanceTransition()
        container.view.frame = window.bounds
        container.view.setNeedsLayout()
        container.view.layoutIfNeeded()
        hosting.view.layoutIfNeeded()
        XCTAssertEqual(hosting.view.bounds.size, family.size, name)

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(size: canvas, format: format).image { context in
            // Hostless tests have no onscreen render-server hierarchy; capture the native layer tree.
            container.view.layer.render(in: context.cgContext)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
        XCTAssertEqual(image.size, canvas, name)
        XCTAssertEqual(image.scale, 1, name)
        let pixels = try Pixels(image: image)
        XCTAssertEqual(pixels.width, Int(canvas.width), name)
        XCTAssertEqual(pixels.height, Int(canvas.height), name)
        self.checkInk(pixels, contentFrame: contentFrame, name: name)

        var visited = Set<ObjectIdentifier>()
        let labels = self.accessibilityLabels(in: hosting.view, visited: &visited)
        XCTAssertEqual(labels, [expectedAccessibility ?? presentation.accessibilityLabel], name)
        return pixels
    }

    private func registerFonts() throws {
        for (resource, postScriptName) in [
            ("Inter[opsz,wght]", "Inter-Regular"),
            ("RedHatDisplay[wght]", "RedHatDisplay-Regular"),
        ] {
            guard UIFont(name: postScriptName, size: 12) == nil else { continue }
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: resource, withExtension: "ttf"))
            XCTAssertTrue(CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil))
            XCTAssertNotNil(UIFont(name: postScriptName, size: 12), "Do not silently render with a fallback font")
        }
    }

    private func attachmentName(
        scenario: String, family: Family, scheme: ColorScheme, typeSize: DynamicTypeSize) throws -> String
    {
        let revision = try XCTUnwrap(Bundle(for: Self.self)
            .object(forInfoDictionaryKey: "OpenClawGitCommit") as? String)
        XCTAssertNotNil(revision.range(of: "^[0-9a-f]{40}$", options: .regularExpression))
        #if targetEnvironment(simulator)
        let platform = "ios-simulator"
        #else
        let platform = "ios-device"
        #endif
        let idiom = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        let appearance = scheme == .dark ? "dark" : "light"
        let type = typeSize == .accessibility5 ? "accessibility5" : "large"
        return "widget-\(scenario)-\(family.name)-\(appearance)-\(type)-\(revision)-" +
            "\(platform)-\(idiom)-\(UIDevice.current.systemVersion)"
    }

    private func accessibilityLabels(in object: NSObject, visited: inout Set<ObjectIdentifier>) -> [String] {
        guard visited.insert(ObjectIdentifier(object)).inserted, !object.accessibilityElementsHidden else { return [] }
        if object.isAccessibilityElement {
            return [object.accessibilityLabel].compactMap(\.self).filter { !$0.isEmpty }
        }
        var children = object.accessibilityElements?.compactMap { $0 as? NSObject } ?? []
        if children.isEmpty {
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 {
                children = (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject }
            } else if let view = object as? UIView {
                children = view.subviews
            }
        }
        return children.flatMap { self.accessibilityLabels(in: $0, visited: &visited) }
    }

    private func checkInk(_ pixels: Pixels, contentFrame: CGRect, name: String) {
        var ink = 0
        var escaped = 0
        for y in 0..<pixels.height {
            for x in 0..<pixels.width {
                let offset = (y * pixels.width + x) * 4
                guard (0..<3).contains(where: { abs(Int(pixels.bytes[offset + $0]) - Int(pixels.bytes[$0])) > 8 })
                else { continue }
                ink += 1
                if !contentFrame.contains(CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5)) {
                    escaped += 1
                }
            }
        }
        XCTAssertGreaterThan(ink, 16, "Blank canvas: \(name)")
        XCTAssertEqual(escaped, 0, "Content escaped the canvas: \(name)")
    }

    private struct Pixels {
        let width: Int
        let height: Int
        let bytes: [UInt8]

        init(image: UIImage) throws {
            let cgImage = try XCTUnwrap(image.cgImage)
            self.width = cgImage.width
            self.height = cgImage.height
            var bytes = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
            try bytes.withUnsafeMutableBytes { buffer in
                let context = try XCTUnwrap(CGContext(
                    data: buffer.baseAddress,
                    width: cgImage.width,
                    height: cgImage.height,
                    bitsPerComponent: 8,
                    bytesPerRow: cgImage.width * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
            }
            self.bytes = bytes
        }

        func differenceBounds(from other: Self) -> CGRect {
            XCTAssertEqual(self.width, other.width)
            XCTAssertEqual(self.height, other.height)
            guard self.bytes.count == other.bytes.count else { return .null }
            var bounds = CGRect.null
            for y in 0..<self.height {
                for x in 0..<self.width {
                    let offset = (y * self.width + x) * 4
                    if (0..<3)
                        .contains(where: { abs(Int(self.bytes[offset + $0]) - Int(other.bytes[offset + $0])) > 8 })
                    {
                        bounds = bounds.union(CGRect(x: x, y: y, width: 1, height: 1))
                    }
                }
            }
            return bounds
        }
    }
}
