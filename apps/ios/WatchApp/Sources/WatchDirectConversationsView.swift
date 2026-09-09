import OpenClawProtocol
import SwiftUI

struct WatchDirectConversationsView: View {
    let gateway: WatchGatewayController
    private var model: WatchDirectConversations {
        self.gateway.conversations
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Direct chat")
                    .font(WatchClawType.title(size: 18))
                Text(self.model.status)
                    .font(WatchClawType.body(size: 12))
                    .foregroundStyle(.secondary)
                if self.gateway.setupIncomplete || self.gateway.recoveryRequired || !self.gateway.isConfigured {
                    NavigationLink(value: WatchDestination.pairWatch) {
                        self.label("Pair Watch", symbol: "key")
                    }
                } else {
                    self.selection
                    if !self.model.scopes.isSuperset(of: ["operator.write", "operator.approvals"]) {
                        Button {
                            Task { await self.model.requestUpgrade() }
                        } label: {
                            self.label("Request chat access", symbol: "lock.open")
                        }
                        .disabled(!self.model.connected || self.model.upgrading)
                    }
                    if self.model.route != nil {
                        self.conversation
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await self.model.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh direct chat")
                .disabled(self.model.busy || self.model.upgrading)
            }
        }
        .task { self.model.appear() }
    }

    private var selection: some View {
        VStack(alignment: .leading, spacing: 8) {
            NavigationLink {
                List(self.model.agents.indices, id: \.self) { index in
                    let agent = self.model.agents[index]
                    Button {
                        Task { await self.model.selectAgent(agent.id) }
                    } label: {
                        HStack {
                            Text(agent.name ?? agent.id)
                                .font(WatchClawType.body(size: 13))
                            if self.model.selectedAgentID?.utf8.elementsEqual(agent.id.utf8) == true {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                    .disabled(self.model.busy || self.model.upgrading)
                }
                .navigationTitle("Agents")
            } label: {
                self.label(self.selectedAgentName, symbol: "person.crop.circle")
            }
            NavigationLink {
                List {
                    Button {
                        Task { await self.model.createSession() }
                    } label: {
                        self.label("New conversation", symbol: "plus")
                    }
                    .disabled(!self.model.canWrite)
                    ForEach(self.model.sessions) { session in
                        Button {
                            Task { await self.model.selectSession(session) }
                        } label: {
                            Text(session.title)
                                .font(WatchClawType.body(size: 13))
                                .lineLimit(3)
                        }
                        .disabled(self.model.busy || self.model.upgrading)
                    }
                }
                .navigationTitle("Conversations")
            } label: {
                self.label(self.selectedSessionName, symbol: "text.bubble")
            }
            .disabled(!self.model.connected)
        }
    }

    private var conversation: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(self.model.messages) { message in
                VStack(alignment: .leading, spacing: 3) {
                    Text(message.role == "user" ? "You" : "OpenClaw")
                        .font(WatchClawType.label(size: 10, weight: .bold))
                        .foregroundStyle(message.role == "user" ? .secondary : WatchClawStyle.accent)
                    Text(message.text)
                        .font(WatchClawType.body(size: 13))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Divider()
            }
            if self.model.historyTruncated {
                Text("Showing recent messages")
                    .font(WatchClawType.body(size: 11))
                    .foregroundStyle(.secondary)
            }
            if let status = self.model.deliveryStatus {
                Text(status)
                    .font(WatchClawType.body(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button {
                    guard let route = self.model.route else { return }
                    WatchNativeTextInput.present(suggestions: []) { text in
                        Task { await self.model.send(text, route: route) }
                    }
                } label: {
                    self.label("Message", symbol: "square.and.pencil")
                }
                .disabled(!self.model.canWrite)
                Button {
                    Task { await self.model.abort() }
                } label: {
                    Image(systemName: "stop.fill")
                }
                .accessibilityLabel("Stop reply")
                .disabled(!self.model.canAbort)
            }
            NavigationLink {
                self.approvals
            } label: {
                self.label("Approvals", symbol: "checkmark.shield")
            }
            .disabled(!self.model.canApprove)
        }
    }

    private var approvals: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if self.model.approvals.isEmpty {
                    Text("No approvals in this conversation")
                        .font(WatchClawType.body(size: 13))
                }
                ForEach(self.model.approvals) { approval in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(approval.title)
                            .font(WatchClawType.title(size: 15))
                        Text(approval.detail)
                            .font(WatchClawType.body(size: 12))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(approval.status)
                            .font(WatchClawType.label(size: 11, weight: .semibold))
                        ForEach(approval.decisions, id: \.rawValue) { decision in
                            Button {
                                Task { await self.model.resolve(approval, decision: decision) }
                            } label: {
                                self.label(
                                    self.decisionTitle(decision),
                                    symbol: decision == .deny ? "xmark" : "checkmark")
                            }
                            .disabled(!self.model.canApprove)
                        }
                    }
                    Divider()
                }
                if self.model.approvalsTruncated {
                    Text("More approvals are available on the Gateway.")
                        .font(WatchClawType.body(size: 12))
                        .foregroundStyle(.secondary)
                }
                Button {
                    Task { await self.model.refresh() }
                } label: {
                    self.label("Refresh", symbol: "arrow.clockwise")
                }
            }
            .padding(.horizontal, 8)
        }
        .navigationTitle("Approvals")
    }

    private var selectedAgentName: String {
        self.model.agents.first(where: {
            $0.id.utf8.elementsEqual((self.model.selectedAgentID ?? "").utf8)
        }).map { $0.name ?? $0.id } ?? String(localized: "Choose agent")
    }

    private var selectedSessionName: String {
        self.model.sessions.first(where: {
            $0.key.utf8.elementsEqual((self.model.route?.sessionKey ?? "").utf8)
        })?.title ?? String(localized: "Choose conversation")
    }

    private func label(_ title: String, symbol: String) -> some View {
        Label {
            Text(title)
                .font(WatchClawType.body(size: 13, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
        }
    }

    private func decisionTitle(_ decision: ApprovalDecision) -> String {
        switch decision {
        case .allowOnce: String(localized: "Allow once")
        case .allowAlways: String(localized: "Always allow")
        case .deny: String(localized: "Deny")
        }
    }
}
