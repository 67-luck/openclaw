import OpenClawKit
import SwiftUI
import UIKit
import WidgetKit

@MainActor
enum OpenClawWidgetProofFixtures {
    enum Group: String, CaseIterable {
        case longLabel = "long-label"
        case compact, recovery

        var testIdentifier: String {
            let method = switch self {
            case .longLabel: "testHomeAndLockFamiliesWithLongLabelsAndDynamicType"
            case .compact: "testCompactOfflineAndFactAgeRemainIndependentlyVisible"
            case .recovery: "testRecoveryAndPrivacyAreExposedWithoutSelectedDetails"
            }
            return "OpenClawWidgetVisualProofTests/\(method)()"
        }
    }

    enum Family: String, CaseIterable {
        case small, medium, large, extraLarge = "extra-large", inline, circular, rectangular

        var value: WidgetFamily {
            switch self {
            case .small: .systemSmall
            case .medium: .systemMedium
            case .large: .systemLarge
            case .extraLarge: .systemExtraLarge
            case .inline: .accessoryInline
            case .circular: .accessoryCircular
            case .rectangular: .accessoryRectangular
            }
        }

        /// Fixed content canvases, not claims about the OS widget gallery's geometry.
        var size: CGSize {
            switch self {
            case .small: CGSize(width: 170, height: 170)
            case .medium: CGSize(width: 364, height: 170)
            case .large: CGSize(width: 364, height: 382)
            case .extraLarge: CGSize(width: 715, height: 342)
            case .inline: CGSize(width: 234, height: 32)
            case .circular: CGSize(width: 76, height: 76)
            case .rectangular: CGSize(width: 172, height: 76)
            }
        }
    }

    enum Appearance: String, CaseIterable {
        case light, dark
        var scheme: ColorScheme {
            self == .dark ? .dark : .light
        }
    }

    enum TextSize: String, CaseIterable {
        case large, accessibility5
        var value: DynamicTypeSize {
            self == .accessibility5 ? .accessibility5 : .large
        }
    }

    struct Fixture: Identifiable {
        let group: Group
        let scenario: String
        let family: Family
        let appearance: Appearance
        let textSize: TextSize

        var id: String {
            "\(self.scenario)-\(self.family.rawValue)-\(self.appearance.rawValue)-\(self.textSize.rawValue)"
        }

        var presentation: OpenClawWidgetPresentation {
            let now = Date(timeIntervalSince1970: 100_000)
            let session = OpenClawNativeSessionRef(
                owner: OpenClawNativeOwnerRef(gatewayID: "proof-gateway", profileID: "proof-profile"),
                agentID: "proof-agent",
                sessionKey: "proof-session")
            let age: TimeInterval? = switch self.scenario {
            case "online-stale", "offline-stale": 600
            case "offline-age-unknown", "online-age-unknown": nil
            case "expired": 86400
            default: 0
            }
            let privacy: OpenClawWidgetPresentation.Privacy = switch self.scenario {
            case "locked", "locked-other-selection": .locked
            case "hidden", "hidden-other-selection": .hidden
            default: .visible
            }
            let availability: OpenClawWidgetPresentation.Availability = switch self.scenario {
            case "unavailable": .unavailable
            case "permission": .permissionDenied
            case "offline-recent", "offline-stale", "offline-age-unknown": .offline
            default: .connected
            }
            let snapshot = OpenClawWidgetSnapshot(
                subject: .run(
                    OpenClawNativeRunRef(session: session, runID: "proof-run"),
                    sessionID: "proof-generation",
                    outcome: self.scenario.hasSuffix("-other-selection") ? .failed : .completed),
                label: self.selectionLabel,
                sourceRecordedAt: age.map { now.addingTimeInterval(-$0) },
                queryObservedAt: now)
            return OpenClawWidgetPresentation.resolve(
                snapshot: self.scenario == "unconfigured" ? nil : snapshot,
                now: now,
                staleAfter: 300,
                expiresAfter: 86400,
                privacy: privacy,
                availability: availability)
        }

        private var selectionLabel: String {
            if self.group == .longLabel { return String(repeating: "Long selected conversation label ", count: 5) }
            return self.scenario.hasSuffix("-other-selection")
                ? "Another private label" : "Private selected conversation"
        }

        /// Independent expectations; never feed these strings into the rendered accessibility tree.
        var expectedLabel: String {
            let status = switch self.scenario {
            case "unconfigured": "Edit widget to select. No selection"
            case "unavailable": "Open OpenClaw. Unavailable"
            case "permission": "Authorize in OpenClaw. Access required"
            case "expired": "Check in OpenClaw. Status expired"
            case "locked", "locked-other-selection": "Unlock to view"
            case "hidden", "hidden-other-selection": "Details hidden"
            case "offline-recent": "Offline: Completed. Last known"
            case "online-stale": "Stale: Completed. Last known"
            case "offline-stale": "Offline, stale: Completed. Last known"
            case "offline-age-unknown": "Offline, age unknown: Completed. Last known"
            case "online-age-unknown": "Age unknown: Completed. Last known"
            default: "Completed. Recorded status"
            }
            return self.group == .recovery ? status : "\(self.selectionLabel.prefix(96)). \(status)"
        }

        var forbiddenLabels: [String] {
            self.group == .recovery
                ? ["Private selected conversation", "Another private label", "Completed", "Failed"] : []
        }
    }

    static let all: [Fixture] = {
        var fixtures: [Fixture] = []
        for family in Family.allCases {
            for appearance in Appearance.allCases {
                for textSize in TextSize.allCases {
                    fixtures.append(Fixture(
                        group: .longLabel,
                        scenario: "long-label",
                        family: family,
                        appearance: appearance,
                        textSize: textSize))
                }
            }
        }
        for family in Family.allCases.suffix(3) {
            for appearance in Appearance.allCases {
                for scenario in [
                    "offline-recent", "online-stale", "offline-stale", "offline-age-unknown", "online-age-unknown",
                ] {
                    fixtures.append(Fixture(
                        group: .compact, scenario: scenario, family: family, appearance: appearance, textSize: .large))
                }
            }
            for scenario in [
                "unconfigured", "unavailable", "permission", "expired", "locked", "locked-other-selection",
                "hidden", "hidden-other-selection",
            ] {
                fixtures.append(Fixture(
                    group: .recovery, scenario: scenario, family: family, appearance: .dark, textSize: .large))
            }
        }
        return fixtures
    }()

    struct Catalog: Encodable {
        struct Entry: Encodable {
            let id: String
            let name: String
            let group: String
            let testIdentifier: String
            let width: Double
            let height: Double
            let expectedLabel: String
            let forbiddenLabels: [String]
        }

        let revision: String
        let platform: String
        let idiom: String
        let osVersion: String
        let cases: [Entry]
    }

    static func catalog(revision: String) -> Catalog {
        #if targetEnvironment(simulator)
        let platform = "ios-simulator"
        #else
        let platform = "ios-device"
        #endif
        let idiom = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        let osVersion = UIDevice.current.systemVersion
        return Catalog(
            revision: revision,
            platform: platform,
            idiom: idiom,
            osVersion: osVersion,
            cases: self.all.map { fixture in
                Catalog.Entry(
                    id: fixture.id,
                    name: "widget-\(fixture.id)-\(revision)-\(platform)-\(idiom)-\(osVersion)",
                    group: fixture.group.rawValue,
                    testIdentifier: fixture.group.testIdentifier,
                    width: fixture.family.size.width,
                    height: fixture.family.size.height,
                    expectedLabel: fixture.expectedLabel,
                    forbiddenLabels: fixture.forbiddenLabels)
            })
    }
}
