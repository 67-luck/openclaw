#if os(iOS)
import SwiftUI
import UIKit

@MainActor
struct ChatComposerTextViewIOS: UIViewRepresentable {
    @Environment(\.isEnabled) private var effectiveEnvironmentEnabled
    @Binding var text: String
    var focusRequested: Bool
    var isEnabled: Bool
    var minHeight: CGFloat
    var maxHeight: CGFloat
    var onFocusChange: (Bool) -> Void
    var onHistoryUp: (Bool) -> Bool
    var onHistoryDown: () -> Bool

    private var interactionEnabled: Bool {
        self.isEnabled && self.effectiveEnvironmentEnabled
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> ChatComposerUITextView {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        textView.probeDesired = self.isEnabled
        textView.probeEnvironment = self.effectiveEnvironmentEnabled
        textView.probeRecord("created")
        textView.delegate = context.coordinator
        textView.text = self.text
        self.configureHistoryHandlers(textView)
        return textView
    }

    func updateUIView(_ textView: ChatComposerUITextView, context: Context) {
        textView.probeDesired = self.isEnabled
        textView.probeEnvironment = self.effectiveEnvironmentEnabled
        textView.probeRecord("update")
        context.coordinator.parent = self
        context.coordinator.scheduleInteractionUpdate(textView)
        self.configureHistoryHandlers(textView)

        // Publishing native input can re-enter SwiftUI with the previous rendered value.
        guard !context.coordinator.isReportingTextChange else { return }
        let isEcho = context.coordinator.lastReportedText == self.text
        if textView.isFirstResponder, isEcho {
            return
        }

        if textView.text != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.text = self.text
            if textView.isFirstResponder {
                textView.selectedRange = NSRange(location: (self.text as NSString).length, length: 0)
            }
            textView.invalidateIntrinsicContentSize()
        }
        context.coordinator.lastReportedText = self.text
    }

    private func configureHistoryHandlers(_ textView: ChatComposerUITextView) {
        textView.onHistoryUp = self.onHistoryUp
        textView.onHistoryDown = self.onHistoryDown
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ChatComposerUITextView,
        context _: Context) -> CGSize?
    {
        guard let width = proposal.width else { return nil }
        let fitting = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        return CGSize(
            width: width,
            height: min(max(fitting.height, self.minHeight), self.maxHeight))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposerTextViewIOS
        var isProgrammaticUpdate = false
        private(set) var isReportingTextChange = false
        var lastReportedText: String?
        private var interactionUpdateScheduled = false

        init(_ parent: ChatComposerTextViewIOS) {
            self.parent = parent
        }

        func scheduleInteractionUpdate(_ textView: ChatComposerUITextView) {
            guard !self.interactionUpdateScheduled else { return }
            self.interactionUpdateScheduled = true
            // Disabling a focused UITextView synchronously resigns first responder.
            // Inside updateUIView that re-enters SwiftUI's responder graph and can
            // spin in AttributeGraph. Apply UIKit state after the graph update,
            // reading the latest parent so a queued disable cannot outlive recovery.
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self else { return }
                self.interactionUpdateScheduled = false
                guard let textView else { return }
                let isEnabled = self.parent.interactionEnabled
                textView.probeRecord("interaction-before")
                if textView.isEditable != isEnabled {
                    textView.isEditable = isEnabled
                }
                if textView.isSelectable != isEnabled {
                    textView.isSelectable = isEnabled
                }
                // UIKit owns user-initiated focus; false is not a blur request.
                if self.parent.focusRequested, isEnabled,
                   !textView.isFirstResponder
                {
                    textView.becomeFirstResponder()
                } else if !isEnabled, textView.isFirstResponder {
                    textView.resignFirstResponder()
                }
                textView.probeRecord("interaction-after")
            }
        }

        func textViewShouldBeginEditing(_ textView: UITextView) -> Bool {
            self.parent.interactionEnabled
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            self.parent.interactionEnabled
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            (textView as? ChatComposerUITextView)?.probeRecord("editing-began")
            self.parent.onFocusChange(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            (textView as? ChatComposerUITextView)?.probeRecord("editing-ended")
            self.parent.onFocusChange(false)
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !self.isProgrammaticUpdate, textView.isFirstResponder else { return }
            self.isReportingTextChange = true
            defer { self.isReportingTextChange = false }
            self.lastReportedText = textView.text
            self.parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
        }
    }
}

@MainActor
final class ChatComposerUITextView: UITextView {
    private let probeID = ChatComposerProbe.editorID()
    var probeDesired = false
    var probeEnvironment = true
    private var probeLastTraits: UInt64?
    private var probeTraitsReads = 0
    private var probeRecording = false

    func probeRecord(_ event: String, traits: UInt64? = nil) {
        guard ChatComposerProbe.enabled, !self.probeRecording else { return }
        self.probeRecording = true
        defer { self.probeRecording = false }
        let base = super.accessibilityTraits
        ChatComposerProbe.record(event, fields: [
            "editor": self.probeID,
            "desired": self.probeDesired,
            "environment": self.probeEnvironment,
            "editable": self.isEditable,
            "selectable": self.isSelectable,
            "interactive": self.isUserInteractionEnabled,
            "focused": self.isFirstResponder,
            "attached": self.window != nil,
            "hidden": self.isHidden,
            "textLength": min(self.text.utf16.count, 1_000_000),
            "baseTraits": String(base.rawValue),
            "baseDisabled": base.contains(.notEnabled),
            "traitReads": self.probeTraitsReads,
            "traits": String(traits ?? (self.isEditable ? base : base.union(.notEnabled)).rawValue),
            "effectiveDisabled": !self.isEditable || base.contains(.notEnabled),
        ])
    }

    var onHistoryUp: ((Bool) -> Bool)?
    var onHistoryDown: (() -> Bool)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        self.probeRecord("window-changed")
    }

    override var accessibilityTraits: UIAccessibilityTraits {
        // Preserve UIKit's dynamic keyboard-focus traits when exposing disabled input.
        get {
            let result = self.isEditable ? super.accessibilityTraits : super.accessibilityTraits.union(.notEnabled)
            if ChatComposerProbe.enabled {
                self.probeTraitsReads += 1
                if self.probeLastTraits != result.rawValue || self.probeTraitsReads.isMultiple(of: 32) {
                    self.probeLastTraits = result.rawValue
                    self.probeRecord("traits-read", traits: result.rawValue)
                }
            }
            return result
        }
        set {
            self.probeRecord("traits-set-before", traits: newValue.rawValue)
            super.accessibilityTraits = newValue
            self.probeRecord("traits-set-after", traits: newValue.rawValue)
        }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandledPresses = presses
        for press in presses {
            guard let key = press.key else { continue }
            if self.handleHardwareKey(key.keyCode, modifierFlags: key.modifierFlags) {
                unhandledPresses.remove(press)
            }
        }
        guard !unhandledPresses.isEmpty else { return }
        super.pressesBegan(unhandledPresses, with: event)
    }

    /// Internal for focused responder-level keyboard routing coverage.
    func handleHardwareKey(
        _ keyCode: UIKeyboardHIDUsage,
        modifierFlags: UIKeyModifierFlags) -> Bool
    {
        let commandModifiers: UIKeyModifierFlags = [.shift, .control, .alternate, .command]
        guard modifierFlags.isDisjoint(with: commandModifiers) else { return false }
        switch keyCode {
        case .keyboardUpArrow:
            return self.onHistoryUp?(self.caretOnFirstLine) == true
        case .keyboardDownArrow:
            return self.onHistoryDown?() == true
        default:
            return false
        }
    }

    private var caretOnFirstLine: Bool {
        let location = min(max(self.selectedRange.location, 0), (self.text as NSString).length)
        let prefix = (self.text as NSString).substring(to: location)
        return !prefix.contains("\n") && !prefix.contains("\r")
    }
}

enum ChatComposerTextViewIOSFactory {
    /// Internal for @testable import coverage of native multiline input defaults.
    @MainActor
    static func makeConfiguredTextView() -> ChatComposerUITextView {
        let textView = ChatComposerUITextView()
        textView.backgroundColor = .clear
        textView.font = OpenClawChatTypography.bodyUIFont
        textView.adjustsFontForContentSizeCategory = true
        textView.allowsEditingTextAttributes = false
        textView.isScrollEnabled = true
        textView.showsVerticalScrollIndicator = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.returnKeyType = .default
        textView.accessibilityIdentifier = "chat-message-input"
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return textView
    }
}
#endif
