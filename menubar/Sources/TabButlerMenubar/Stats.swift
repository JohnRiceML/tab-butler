import Foundation
import Combine
import Darwin

struct ServerInfo: Identifiable {
    let id = UUID()
    let port: Int
    let pid: Int
    let command: String
}

/// Reads real OS-level stats: Chrome per-process RAM (the honest per-process
/// figure — Site Isolation makes per-tab impossible), system memory, and
/// listening localhost dev servers. All via shelling out, so no task_for_pid
/// entitlement is needed.
final class StatsModel: ObservableObject {
    struct ProcRow: Identifiable { let id = UUID(); let name: String; let gb: Double }

    @Published var chromeGB: Double = 0
    @Published var systemUsedGB: Double = 0
    @Published var systemTotalGB: Double = 0
    @Published var topProcs: [ProcRow] = []
    @Published var servers: [ServerInfo] = []

    var menubarTitle: String {
        chromeGB > 0 ? String(format: "%.1fG", chromeGB) : "—"
    }

    func refresh(completion: @escaping () -> Void = {}) {
        DispatchQueue.global(qos: .utility).async {
            let (chrome, top) = StatsModel.chromeMemory()
            let (used, total) = StatsModel.systemMemory()
            let srv = StatsModel.devServers()
            DispatchQueue.main.async {
                self.chromeGB = chrome
                self.topProcs = top
                self.systemUsedGB = used
                self.systemTotalGB = total
                self.servers = srv
                completion()
            }
        }
    }

    // MARK: - shell helper

    private static func run(_ path: String, _ args: [String]) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do { try proc.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - Chrome memory (sum of all Chrome process RSS)

    private static func chromeMemory() -> (Double, [ProcRow]) {
        let out = run("/bin/ps", ["-axo", "rss=,comm="])
        var total = 0.0
        var rows: [ProcRow] = []
        for line in out.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let sp = trimmed.firstIndex(of: " ") else { continue }
            let rssStr = String(trimmed[..<sp])
            let comm = String(trimmed[trimmed.index(after: sp)...]).trimmingCharacters(in: .whitespaces)
            guard let rssKB = Double(rssStr), comm.contains("Google Chrome") else { continue }
            let gb = rssKB / 1_048_576.0
            total += gb
            rows.append(ProcRow(name: shortLabel(comm), gb: gb))
        }
        let top = Array(rows.sorted { $0.gb > $1.gb }.prefix(6))
        return (total, top)
    }

    private static func shortLabel(_ comm: String) -> String {
        let base = comm.split(separator: "/").last.map(String.init) ?? comm
        return base
            .replacingOccurrences(of: "Google Chrome ", with: "")
            .replacingOccurrences(of: "Google Chrome", with: "Chrome")
    }

    // MARK: - System memory

    private static func systemMemory() -> (Double, Double) {
        let total = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        let out = run("/usr/bin/vm_stat", [])
        var pageSize = 16384.0
        if let r = out.range(of: "page size of ") {
            let digits = out[r.upperBound...].prefix(while: { $0.isNumber })
            if let v = Double(String(digits)) { pageSize = v }
        }
        func pages(_ key: String) -> Double {
            guard let r = out.range(of: key) else { return 0 }
            let digits = out[r.upperBound...].drop(while: { !$0.isNumber }).prefix(while: { $0.isNumber })
            return Double(String(digits)) ?? 0
        }
        let usedPages = pages("Pages active:") + pages("Pages wired down:") + pages("Pages occupied by compressor:")
        let used = usedPages * pageSize / 1_073_741_824.0
        return (used, total)
    }

    // MARK: - localhost dev servers

    private static let devCmds = [
        "node", "deno", "bun", "python", "ruby", "php", "rails", "puma",
        "vite", "next", "webpack", "cargo", "go", "dotnet", "java", "gradle",
        "flask", "gunicorn", "uvicorn",
    ]

    private static func devServers() -> [ServerInfo] {
        let out = run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])
        var seen = Set<Int>()
        var list: [ServerInfo] = []
        for line in out.split(separator: "\n").dropFirst() {
            let cols = line.split(separator: " ", omittingEmptySubsequences: true)
            guard cols.count >= 9, let pid = Int(String(cols[1])) else { continue }
            let command = String(cols[0])
            let name = String(cols[8])
            guard let colon = name.lastIndex(of: ":") else { continue }
            guard let port = Int(String(name[name.index(after: colon)...])), !seen.contains(port) else { continue }
            let isDev = devCmds.contains { command.lowercased().hasPrefix($0) }
            if isDev {
                seen.insert(port)
                list.append(ServerInfo(port: port, pid: pid, command: command))
            }
        }
        return list.sorted { $0.port < $1.port }
    }

    /// SIGTERM whatever is listening on `port`. Dev servers only (the UI is
    /// already filtered), and only listening processes are touched.
    static func killServer(port: Int) {
        let out = run("/usr/sbin/lsof", ["-nP", "-tiTCP:\(port)", "-sTCP:LISTEN"])
        for pidStr in out.split(separator: "\n") {
            if let pid = Int(pidStr.trimmingCharacters(in: .whitespaces)) {
                kill(pid_t(pid), SIGTERM)
            }
        }
    }
}
