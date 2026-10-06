// 苹果自带语音识别（SpeechAnalyzer，本地运行，不联网）。
// 用法：apple_asr <语言，如 en-US>
// 从标准输入读 16kHz 单声道 int16 PCM，向标准输出逐行写 JSON：
//   {"type":"ready"}                         模型就绪
//   {"type":"partial","text":"..."}          还在说的这句（边说边变）
//   {"type":"final","text":"...","conf":0.9,"start":1.2,"end":3.4}   确定下来的一句（conf 为识别把握）
//   {"type":"error","msg":"..."}
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

let localeId = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "en-US"

func run() async throws {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
        emit(["type": "error", "msg": "苹果语音识别不支持这种语言：\(localeId)"])
        exit(2)
    }
    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],  // 边说边出字
        attributeOptions: [.audioTimeRange, .transcriptionConfidence]
    )
    // 第一次用某种语言要先下载模型（系统统一管理，只下一次）
    if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        emit(["type": "downloading"])
        try await req.downloadAndInstall()
    }

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
        emit(["type": "error", "msg": "拿不到可用的音频格式"])
        exit(3)
    }
    try await analyzer.prepareToAnalyze(in: format)

    let inFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    let converter = AVAudioConverter(from: inFormat, to: format)!
    let (inputs, cont) = AsyncStream<AnalyzerInput>.makeStream()

    // 读标准输入：每次约 100ms 音频，转换成识别需要的格式后送进去
    let reader = Thread {
        let chunkBytes = 3200
        var buf = [UInt8](repeating: 0, count: chunkBytes)
        while true {
            let n = fread(&buf, 1, chunkBytes, stdin)
            if n <= 0 { break }
            let frames = AVAudioFrameCount(n / 2)
            guard frames > 0, let src = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames) else { continue }
            src.frameLength = frames
            buf.withUnsafeBytes { raw in
                memcpy(src.int16ChannelData![0], raw.baseAddress!, Int(frames) * 2)
            }
            let cap = AVAudioFrameCount(Double(frames) * format.sampleRate / 16000) + 16
            guard let dst = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { continue }
            var fed = false
            var err: NSError?
            converter.convert(to: dst, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true
                status.pointee = .haveData
                return src
            }
            if dst.frameLength > 0 { cont.yield(AnalyzerInput(buffer: dst)) }
        }
        cont.finish()
    }
    reader.start()

    let printer = Task {
        for try await r in transcriber.results {
            let text = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            if !r.isFinal {
                emit(["type": "partial", "text": text])  // 草稿没有把握值
                continue
            }
            // 确定下来的结果按句切开，每句单独给出把握（0~1）和时间：
            // 说的不是所选语言时把握会明显偏低，中英文连着说也能逐句分开过滤
            var sentence = "", sum = 0.0, count = 0.0
            var start: Double? = nil, end = r.range.end.seconds
            func flush() {
                let t = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty {
                    emit(["type": "final", "text": t, "conf": count > 0 ? sum / count : -1,
                          "start": start ?? r.range.start.seconds, "end": end])
                }
                sentence = ""; sum = 0; count = 0; start = nil
            }
            for run in r.text.runs {
                let piece = String(r.text[run.range].characters)
                sentence += piece
                if let c = run.transcriptionConfidence {
                    sum += c * Double(piece.count)
                    count += Double(piece.count)
                }
                if let tr = run.audioTimeRange {
                    if start == nil { start = tr.start.seconds }
                    end = tr.end.seconds
                }
                if let last = piece.trimmingCharacters(in: .whitespaces).last, ".?!。？！".contains(last) { flush() }
            }
            flush()
        }
    }

    emit(["type": "ready", "locale": locale.identifier])
    try await analyzer.start(inputSequence: inputs)
    // 等输入读完，再把最后一句确定下来
    while !reader.isFinished { try await Task.sleep(nanoseconds: 50_000_000) }
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    try await printer.value
}

Task {
    do { try await run() } catch {
        emit(["type": "error", "msg": "\(error)"])
        exit(1)
    }
    exit(0)
}
RunLoop.main.run()
