// 录电脑内部正在播放的声音（视频、电影、网课），不经过麦克风。
// 用 macOS 的 Core Audio Tap：第一次运行时系统会询问是否允许录制系统音频。
// 向标准输出持续写 16kHz 单声道 int16 PCM，标准错误输出 JSON 状态：
//   {"type":"ready"}  /  {"type":"error","msg":"..."}
import AVFoundation
import CoreAudio
import Foundation

func status(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}

func fail(_ msg: String, _ err: OSStatus) -> Never {
    status(["type": "error", "msg": "\(msg)（错误码 \(err)）"])
    exit(1)
}

// 1. 建一个"全局"监听：所有程序播放的声音，混成单声道；不静音，扬声器照常出声
let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
desc.uuid = UUID()
desc.isPrivate = true
desc.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
var err = AudioHardwareCreateProcessTap(desc, &tapID)
if err != noErr { fail("无法监听系统声音，可能没有授权", err) }

// 2. 读出这个监听的音频格式
var fmt = AudioStreamBasicDescription()
var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var addr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
                                      mElement: kAudioObjectPropertyElementMain)
err = AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &fmt)
if err != noErr { fail("读取系统声音格式失败", err) }

// 3. 用它建一个私有的聚合设备，才能真正把声音读出来
let aggUID = UUID().uuidString
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "课堂同传-系统声音",
    kAudioAggregateDeviceUIDKey: aggUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: desc.uuid.uuidString]],
]
var aggID = AudioObjectID(kAudioObjectUnknown)
err = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
if err != noErr { fail("创建采集设备失败", err) }

func cleanup() {
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
}
signal(SIGTERM) { _ in cleanup(); exit(0) }
signal(SIGINT) { _ in cleanup(); exit(0) }
signal(SIGPIPE) { _ in cleanup(); exit(0) }  // 服务端关掉了，跟着退出

// 4. 转成 16kHz 单声道 int16，写到标准输出
guard let inFormat = AVAudioFormat(streamDescription: &fmt) else { fail("不支持的音频格式", -1) }
let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
let converter = AVAudioConverter(from: inFormat, to: outFormat)!
let out = FileHandle.standardOutput
let lock = NSLock()
var lastWrite = Date()
func write(_ data: Data) {
    lock.lock(); defer { lock.unlock() }
    out.write(data)
    lastWrite = Date()
}
// 电脑没在放声音时系统不给任何数据：补上静音，让识别知道这句话说完了
let silence = Data(count: 1600 * 2)  // 100ms
let filler = DispatchSource.makeTimerSource(queue: .global())
filler.schedule(deadline: .now() + 0.1, repeating: 0.1)
filler.setEventHandler {
    lock.lock(); let idle = Date().timeIntervalSince(lastWrite); lock.unlock()
    if idle > 0.15 { write(silence) }
}

var procID: AudioDeviceIOProcID?
err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) { _, inData, _, _, _ in
    let frames = inData.pointee.mBuffers.mDataByteSize / inFormat.streamDescription.pointee.mBytesPerFrame
    guard frames > 0,
          let src = AVAudioPCMBuffer(pcmFormat: inFormat, bufferListNoCopy: inData, deallocator: nil) else { return }
    src.frameLength = frames
    let cap = AVAudioFrameCount(Double(frames) * 16000 / inFormat.sampleRate) + 16
    guard let dst = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
    var fed = false
    var cerr: NSError?
    converter.convert(to: dst, error: &cerr) { _, st in
        if fed { st.pointee = .noDataNow; return nil }
        fed = true
        st.pointee = .haveData
        return src
    }
    if dst.frameLength > 0 {
        write(Data(bytes: dst.int16ChannelData![0], count: Int(dst.frameLength) * 2))
    }
}
if err != noErr { fail("无法读取系统声音", err) }
err = AudioDeviceStart(aggID, procID)
if err != noErr { fail("无法开始录制系统声音", err) }
filler.resume()
status(["type": "ready", "rate": inFormat.sampleRate, "channels": inFormat.channelCount])

// 标准输入关闭（服务端退出）就结束
DispatchQueue.global().async {
    while let d = try? FileHandle.standardInput.read(upToCount: 1), !d.isEmpty {}
    AudioDeviceStop(aggID, procID)
    cleanup()
    exit(0)
}
RunLoop.main.run()
