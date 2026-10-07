// 后台线程：加载本地识别模型，持续解码，把结果切成句子发回主线程。放在线程里是为了加载（1~6 秒）和解码都不卡窗口。
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SR = 16000;

(async () => {
  const dir = workerData.modelDir;
  for (const f of ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"]) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`找不到模型文件 ${f}`);
  }
  const { SentenceSplitter } = await import(pathToFileURL(path.join(__dirname, "sentences.js")).href);
  const sherpa = require("sherpa-onnx");
  const recognizer = sherpa.createOnlineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: path.join(dir, "encoder.onnx"), decoder: path.join(dir, "decoder.onnx"), joiner: path.join(dir, "joiner.onnx") },
      tokens: path.join(dir, "tokens.txt"), numThreads: 1, provider: "cpu", debug: 0,
    },
    decodingMethod: "greedy_search", maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,   // 还没识别出字时，静音多久算一段结束
    rule2MinTrailingSilence: 0.8,   // 识别出字之后，停顿多久算一段结束
    rule3MinUtteranceLength: 120,   // 一直讲不停、中间没有停顿时，最长多久强制结束一段（20 秒没标点的兜底在句子切分器里，不会切断正常的句子）
  });
  const stream = recognizer.createStream();
  const splitter = new SentenceSplitter();
  let lastPartial = "", samples = 0;

  function step(flush) {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const endpoint = flush || recognizer.isEndpoint(stream);
    const { finals, partial, partialConf } = splitter.update(recognizer.getResult(stream), { flush: endpoint });
    for (const f of finals) parentPort.postMessage({ type: "final", ...f });
    if (partial !== lastPartial) {
      lastPartial = partial;
      parentPort.postMessage({ type: "partial", text: partial, conf: partialConf });
    }
    if (endpoint) { recognizer.reset(stream); splitter.reset(); }
  }

  parentPort.on("message", (m) => {
    if (m.type === "audio") {
      const n = m.pcm.byteLength >> 1;
      const view = new DataView(m.pcm.buffer, m.pcm.byteOffset, n * 2);
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
      stream.acceptWaveform(SR, f32);
      samples += n;
      step(false);
      parentPort.postMessage({ type: "tick", processed: samples / SR });
    } else if (m.type === "finish") {
      stream.acceptWaveform(SR, new Float32Array(SR * 2)); // 补 2 秒静音：补少了最后一个词解不出来
      stream.inputFinished();
      step(true);
      parentPort.postMessage({ type: "done" });
    }
  });
  parentPort.postMessage({ type: "ready" });
})().catch((e) => {
  parentPort.postMessage({ type: "error", msg: String(e?.message ?? e) });
  process.exit(1);
});
