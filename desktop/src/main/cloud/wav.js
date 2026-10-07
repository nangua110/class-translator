/** 16kHz 单声道 Float32 → WAV（发给 Gemini 用） */
export function toWav(f32, sr = 16000) {
  const buf = Buffer.alloc(44 + f32.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + f32.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);      // fmt 块长度
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // 单声道
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);  // 每秒字节数
  buf.writeUInt16LE(2, 32);       // 每帧字节数
  buf.writeUInt16LE(16, 34);      // 位深
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(f32.length * 2, 40);
  f32.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}
