import SwiftUI
import WidgetKit

struct OpenClawStatusWidgetView: View {
    let presentation: OpenClawWidgetPresentation
    @Environment(\.widgetFamily) private var family

    var body: some View {
        OpenClawStatusWidgetContent(presentation: self.presentation, family: self.family)
    }
}

struct OpenClawStatusWidgetContent: View {
    let presentation: OpenClawWidgetPresentation
    let family: WidgetFamily

    var body: some View {
        Group {
            switch self.family {
            case .accessoryInline:
                ViewThatFits(in: .vertical) {
                    self.statusLine()
                    self.statusLine(compact: true)
                }
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    self.circularStatusSymbol
                }
            case .accessoryRectangular:
                ViewThatFits(in: .vertical) {
                    self.summary(labelLineLimit: 1)
                    self.statusLine()
                }
            case .systemSmall, .systemMedium, .systemLarge, .systemExtraLarge:
                ViewThatFits(in: .vertical) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("OpenClaw")
                            .font(OpenClawActivityType.caption)
                            .foregroundStyle(.secondary)
                        self.summary(labelLineLimit: 2)
                    }
                    self.summary(labelLineLimit: 1)
                    self.statusLine()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            @unknown default:
                self.statusLine()
            }
        }
        .privacySensitive()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: self.presentation.accessibilityLabel))
    }

    private func summary(labelLineLimit: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let label = self.presentation.label {
                Text(verbatim: label)
                    .font(OpenClawActivityType.subheadSemiBold)
                    .lineLimit(labelLineLimit)
                    .minimumScaleFactor(0.8)
            }
            self.statusLine()
            if !self.presentation.contextText.isEmpty {
                Text(verbatim: self.presentation.contextText)
                    .font(OpenClawActivityType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
        }
    }

    private func statusLine(compact: Bool = false) -> some View {
        Label {
            Text(verbatim: self.presentation.statusText)
                .font(compact ? OpenClawActivityType.caption2 : OpenClawActivityType.caption)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        } icon: {
            self.statusSymbol
        }
    }

    private var statusSymbol: some View {
        Image(systemName: self.symbol)
            .font(OpenClawActivityType.symbol(size: 16, weight: .semibold))
            .foregroundStyle(.primary)
            .frame(width: 28, height: 28)
    }

    private var circularStatusSymbol: some View {
        VStack(spacing: 2) {
            self.statusSymbol
            // Separate fixed slots keep offline and fact age independently visible.
            HStack(spacing: 4) {
                Image(systemName: "wifi.slash")
                    .opacity(self.presentation.isOffline ? 1 : 0)
                    .frame(width: 12, height: 12)
                Group {
                    switch (self.presentation.freshness, self.presentation.state) {
                    case (.stale, _):
                        Image(systemName: "clock")
                    case (.unknown, .queued), (.unknown, .running), (.unknown, .terminal):
                        Image(systemName: "questionmark")
                    default:
                        Color.clear
                    }
                }
                .frame(width: 12, height: 12)
            }
            .font(OpenClawActivityType.symbol(size: 9, weight: .bold))
            .foregroundStyle(.secondary)
        }
        .frame(width: 28, height: 42)
    }

    private var symbol: String {
        switch self.presentation.state {
        case .unknown: "questionmark.circle"
        case .queued: "clock"
        case .running: "arrow.triangle.2.circlepath"
        case .terminal(.completed): "checkmark.circle"
        case .terminal(.failed): "exclamationmark.circle"
        case .terminal(.cancelled): "xmark.circle"
        case .terminal(.timedOut), .expired: "clock.badge.exclamationmark"
        case .unconfigured: "plus.circle"
        case .unavailable: "slash.circle"
        case .permissionRequired, .locked: "lock"
        case .hidden: "eye.slash"
        }
    }
}
