import SwiftUI
import AppKit

struct ContentView: View {
    @ObservedObject var model: StatsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "rectangle.3.group")
                Text("Tab Butler").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button { NSApp.terminate(nil) } label: {
                    Image(systemName: "power")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("Quit Tab Butler")
            }

            // Memory card
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Chrome").foregroundStyle(.secondary)
                    Spacer()
                    Text(String(format: "%.1f GB", model.chromeGB))
                        .font(.system(size: 16, weight: .medium))
                }
                ProgressView(value: min(model.chromeGB / max(model.systemTotalGB, 1), 1))
                Text(String(format: "System %.1f / %.1f GB used", model.systemUsedGB, model.systemTotalGB))
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))

            if !model.topProcs.isEmpty {
                Text("TOP CHROME PROCESSES").font(.caption2).foregroundStyle(.tertiary)
                ForEach(model.topProcs) { p in
                    HStack {
                        Text(p.name).lineLimit(1)
                        Spacer()
                        Text(String(format: "%.0f MB", p.gb * 1024)).foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12))
                }
            }

            Text("LOCALHOST · SERVERS RUNNING").font(.caption2).foregroundStyle(.tertiary)
            if model.servers.isEmpty {
                Text("No dev servers running.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(model.servers) { s in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("localhost:\(String(s.port))").font(.system(size: 13, weight: .medium))
                            Text(s.command).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Kill") {
                            StatsModel.killServer(port: s.port)
                            model.refresh()
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.red)
                    }
                }
            }

            Spacer(minLength: 0)
            Text("RAM is per process — browsers can't split it cleanly per tab.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(16)
        .frame(width: 360)
    }
}
