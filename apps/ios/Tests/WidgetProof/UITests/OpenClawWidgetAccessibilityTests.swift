import UIKit
import XCTest

@MainActor
final class OpenClawWidgetAccessibilityTests: XCTestCase {
    private struct Element: Encodable {
        let identifier: String
        let label: String
    }

    private struct PrivateChildren: Encodable {
        let label: String
        let count: Int
    }

    private struct Observation: Encodable {
        let id: String
        let identifier: String
        let label: String
        let queryCount: Int
        let children: [Element]
        let privateChildren: [PrivateChildren]
    }

    private struct Evidence: Encodable {
        let revision: String
        let hostRevision: String
        let cases: [Observation]
    }

    func testWidgetAccessibilityCatalog() throws {
        let revision = try XCTUnwrap(Bundle(for: Self.self)
            .object(forInfoDictionaryKey: "OpenClawGitCommit") as? String)
        XCTAssertNotNil(revision.range(of: "^[0-9a-f]{40}$", options: .regularExpression))
        let catalog = OpenClawWidgetProofFixtures.catalog(revision: revision)
        try self.attach(catalog, name: "widget-catalog-\(revision)")
        XCTAssertEqual(catalog.cases.count, 82)
        let app = XCUIApplication()
        let orientation = XCUIDevice.shared.orientation
        var observations: [Observation] = []
        var hostRevision = ""
        defer {
            do {
                try self.attach(
                    Evidence(revision: revision, hostRevision: hostRevision, cases: observations),
                    name: "widget-accessibility-\(revision)")
            } catch {
                XCTFail("Could not retain observed accessibility evidence: \(error)")
            }
            app.terminate()
            XCUIDevice.shared.orientation = orientation
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        let revisionElement = app.staticTexts["widget-proof-revision"]
        XCTAssertTrue(revisionElement.waitForExistence(timeout: 5))
        hostRevision = revisionElement.label
        XCTAssertEqual(hostRevision, revision)

        for (index, fixture) in OpenClawWidgetProofFixtures.all.enumerated() {
            let matches = app.descendants(matching: .any).matching(identifier: fixture.id)
            let element = matches.firstMatch
            let exists = element.waitForExistence(timeout: 5)
            XCTAssertTrue(exists, fixture.id)
            let count = matches.count
            let children = exists ? element.descendants(matching: .any).allElementsBoundByIndex.map {
                Element(identifier: $0.identifier, label: $0.label)
            } : []
            let privateChildren = fixture.forbiddenLabels.map { label in
                PrivateChildren(
                    label: label,
                    count: app.descendants(matching: .any)
                        .matching(NSPredicate(format: "label CONTAINS %@", label)).count)
            }
            let observation = Observation(
                id: fixture.id,
                identifier: exists ? element.identifier : "",
                label: exists ? element.label : "",
                queryCount: count,
                children: children,
                privateChildren: privateChildren)
            observations.append(observation)
            XCTAssertEqual(count, 1, fixture.id)
            XCTAssertEqual(observation.identifier, fixture.id)
            XCTAssertEqual(observation.label, fixture.expectedLabel, fixture.id)
            XCTAssertTrue(children.isEmpty, "Only the production accessibility group should be exposed: \(fixture.id)")
            for child in privateChildren {
                XCTAssertEqual(child.count, 0, "Private child exposed: \(fixture.id), \(child.label)")
            }
            let viewport = app.scrollViews["widget-proof-viewport"].frame
            XCTAssertGreaterThanOrEqual(viewport.width, fixture.family.size.width + 16, fixture.id)
            XCTAssertGreaterThanOrEqual(viewport.height, fixture.family.size.height + 16, fixture.id)
            if index < OpenClawWidgetProofFixtures.all.count - 1 {
                let next = app.buttons["widget-proof-next"]
                XCTAssertTrue(next.isHittable, fixture.id)
                next.tap()
            }
        }
        XCTAssertEqual(observations.count, 82)
    }

    private func attach(_ value: some Encodable, name: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let attachment = try XCTAttachment(data: encoder.encode(value), uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
