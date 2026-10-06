// 苹果自带翻译（本地运行，免费、不联网、没有额度限制）。
// 从标准输入逐行读 JSON：{"id":1,"text":"...","src":"en","tgt":"zh-Hans"}
// 向标准输出逐行写：{"id":1,"tr":"..."} 或 {"id":1,"error":"...","code":"not_installed|unsupported|failed"}
// 用法：apple_translate            常驻翻译
//       apple_translate check en zh-Hans   只查这对语言能不能用，输出 installed / supported / unsupported
import Foundation
import Translation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        print(s)
    }
}

func availability(_ src: String, _ tgt: String) async -> LanguageAvailability.Status {
    await LanguageAvailability().status(from: Locale.Language(identifier: src), to: Locale.Language(identifier: tgt))
}

var sessions: [String: TranslationSession] = [:]  // 每对语言建一次，之后复用

func translate(_ text: String, _ src: String, _ tgt: String) async -> [String: Any] {
    let key = "\(src)>\(tgt)"
    if sessions[key] == nil {
        switch await availability(src, tgt) {
        case .unsupported:
            return ["error": "苹果翻译不支持这对语言", "code": "unsupported"]
        case .supported:
            return ["error": "还没下载这对语言的翻译模型", "code": "not_installed"]
        case .installed:
            sessions[key] = TranslationSession(installedSource: Locale.Language(identifier: src),
                                               target: Locale.Language(identifier: tgt))
        @unknown default:
            return ["error": "未知状态", "code": "failed"]
        }
    }
    do {
        let r = try await sessions[key]!.translate(text)
        return ["tr": r.targetText]
    } catch {
        sessions[key] = nil
        return ["error": "\(error)", "code": "failed"]
    }
}

Task {
    let args = CommandLine.arguments
    if args.count == 4 && args[1] == "check" {
        switch await availability(args[2], args[3]) {
        case .installed: print("installed")
        case .supported: print("supported")
        default: print("unsupported")
        }
        exit(0)
    }
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = req["text"] as? String, let src = req["src"] as? String, let tgt = req["tgt"] as? String
        else { continue }
        var out = await translate(text, src, tgt)
        out["id"] = req["id"] ?? NSNull()
        emit(out)
    }
    exit(0)
}
RunLoop.main.run()
