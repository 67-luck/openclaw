import SwiftUI

struct GatewaySetupFailureView: View {
    let failure: GatewaySetupApplication.Failure
    let isBusy: Bool
    let onRetry: () -> Void
    let onScan: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text("Couldn't finish setup")
                    .font(OpenClawType.subheadSemiBold)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(OpenClawBrand.warn)
            }
            Text(verbatim: self.failure.message)
                .font(OpenClawType.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: self.failure.allowsRetry ? self.onRetry : self.onScan) {
                if self.isBusy {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Preparing…")
                            .font(OpenClawType.subheadSemiBold)
                    }
                } else if self.failure.allowsRetry {
                    Text("Try Again")
                        .font(OpenClawType.subheadSemiBold)
                } else {
                    Text("Scan New Code")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.isBusy)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("GatewaySetup.Failure")
    }
}
