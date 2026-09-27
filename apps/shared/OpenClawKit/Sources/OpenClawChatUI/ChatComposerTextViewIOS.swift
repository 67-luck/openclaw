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
    var typingProbeLog: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> ChatComposerUITextView {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        textView.installTypingProbe(
            log: self.typingProbeLog,
            enabled: self.isEnabled,
            environmentEnabled: self.effectiveEnvironmentEnabled,
            modelLength: self.text.utf16.count)
        textView.delegate = context.coordinator
        textView.text = self.text
        self.configureHistoryHandlers(textView)
        return textView
    }

    func updateUIView(_ textView: ChatComposerUITextView, context: Context) {
        if ChatTypingProbe.enabled {
            textView.typingProbeLog = self.typingProbeLog
            textView.typingProbeDesiredEnabled = self.isEnabled
            textView.typingProbeModelLength = self.text.utf16.count
            if textView.typingProbeEnvironmentEnabled != self.effectiveEnvironmentEnabled {
                textView.typingProbeEnvironmentEnabled = self.effectiveEnvironmentEnabled
                ChatTypingProbe.emit("environment-changed", editor: textView)
            }
        }
        context.coordinator.parent = self
        context.coordinator.scheduleInteractionUpdate(textView)
        self.configureHistoryHandlers(textView)

        let isEcho = context.coordinator.lastReportedText == self.text
        if textView.isFirstResponder, isEcho {
            return
        }

        if textView.text != self.text {
            ChatTypingProbe.emit("update-before", editor: textView)
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.text = self.text
            if textView.isFirstResponder {
                textView.selectedRange = NSRange(location: (self.text as NSString).length, length: 0)
            }
            textView.invalidateIntrinsicContentSize()
            ChatTypingProbe.emit("update-value", editor: textView)
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
                let changesInteraction = textView.isEditable != self.parent.isEnabled ||
                    textView.isSelectable != self.parent.isEnabled
                if changesInteraction { ChatTypingProbe.emit("interaction-before", editor: textView) }
                if textView.isEditable != self.parent.isEnabled {
                    textView.isEditable = self.parent.isEnabled
                }
                if textView.isSelectable != self.parent.isEnabled {
                    textView.isSelectable = self.parent.isEnabled
                }
                // UIKit owns user-initiated focus; false is not a blur request.
                if self.parent.focusRequested, self.parent.isEnabled,
                   !textView.isFirstResponder
                {
                    textView.becomeFirstResponder()
                } else if !self.parent.isEnabled, textView.isFirstResponder {
                    textView.resignFirstResponder()
                }
                if changesInteraction { ChatTypingProbe.emit("interaction-after", editor: textView) }
            }
        }

        func textViewShouldBeginEditing(_ textView: UITextView) -> Bool {
            self.parent.isEnabled
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            self.parent.isEnabled
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if let editor = textView as? ChatComposerUITextView {
                ChatTypingProbe.emit("editing-began", editor: editor)
            }
            self.parent.onFocusChange(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if let editor = textView as? ChatComposerUITextView {
                ChatTypingProbe.emit("editing-ended", editor: editor)
            }
            self.parent.onFocusChange(false)
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !self.isProgrammaticUpdate, textView.isFirstResponder else { return }
            self.lastReportedText = textView.text
            self.parent.text = textView.text
            if ChatTypingProbe.enabled, let editor = textView as? ChatComposerUITextView {
                editor.typingProbeModelLength = self.parent.text.utf16.count
                ChatTypingProbe.emit("text-changed", editor: editor)
            }
            textView.invalidateIntrinsicContentSize()
        }
    }
}

@MainActor
final class ChatComposerUITextView: UITextView {
    var onHistoryUp: ((Bool) -> Bool)?
    var onHistoryDown: (() -> Bool)?
    var typingProbeLog: ((String) -> Void)?
    var typingProbeID = 0
    var typingProbeDesiredEnabled = false
    var typingProbeEnvironmentEnabled = true
    var typingProbeModelLength = 0

    func installTypingProbe(
        log: ((String) -> Void)?, enabled: Bool, environmentEnabled: Bool, modelLength: Int)
    {
        guard ChatTypingProbe.enabled, self.typingProbeID == 0 else { return }
        self.typingProbeID = ChatTypingProbe.editorID()
        self.typingProbeLog = log
        self.typingProbeDesiredEnabled = enabled
        self.typingProbeEnvironmentEnabled = environmentEnabled
        self.typingProbeModelLength = modelLength
        for name in [
            UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidShowNotification,
            UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification,
        ] {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.typingProbeKeyboard(_:)),
                name: name,
                object: nil)
        }
        ChatTypingProbe.emit("editor-created", editor: self)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        ChatTypingProbe.emit("editor-window", editor: self)
    }

    override func becomeFirstResponder() -> Bool {
        ChatTypingProbe.emit("focus-request", editor: self)
        let result = super.becomeFirstResponder()
        ChatTypingProbe.emit("focus-result", editor: self, result: result)
        return result
    }

    override func resignFirstResponder() -> Bool {
        ChatTypingProbe.emit("blur-request", editor: self)
        let result = super.resignFirstResponder()
        ChatTypingProbe.emit("blur-result", editor: self, result: result)
        return result
    }

    @objc private func typingProbeKeyboard(_ notification: Notification) {
        let event: String
        switch notification.name {
        case UIResponder.keyboardWillShowNotification: event = "keyboard-will-show"
        case UIResponder.keyboardDidShowNotification: event = "keyboard-did-show"
        case UIResponder.keyboardWillHideNotification: event = "keyboard-will-hide"
        case UIResponder.keyboardDidHideNotification: event = "keyboard-did-hide"
        default: return
        }
        let frame = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        ChatTypingProbe.emit(event, editor: self, keyboardHeight: frame.map { Double($0.height) })
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
