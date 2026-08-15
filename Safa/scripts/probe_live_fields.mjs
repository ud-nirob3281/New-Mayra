// Raw probe: feed real speech audio into a Gemini Live session and dump which
// serverContent fields actually carry the user/model transcripts in VOICE mode.
import fs from 'fs';
import { GoogleGenAI, Modality } from '@google/genai';

const key = JSON.parse(fs.readFileSync(process.env.SECRETS, 'utf8')).geminiApiKey;
const ai = new GoogleGenAI({ apiKey: key });

// 1) Generate a short spoken prompt via TTS (24kHz PCM)
const tts = await ai.models.generateContent({
  model: 'gemini-2.5-flash-preview-tts',
  contents: [{ role: 'user', parts: [{ text: 'Say calmly: Hello Safa, please remember the code word GREEN FALCON ninety two.' }] }],
  config: {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
  },
});
const b64 = tts.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
if (!b64) { console.error('TTS failed'); process.exit(1); }
const pcm24 = Buffer.from(b64, 'base64');

// 2) Resample 24k -> 16k (linear interpolation)
const ratio = 24000 / 16000;
const outLen = Math.floor(pcm24.length / 2 / ratio);
const pcm16 = Buffer.alloc(outLen * 2);
for (let i = 0; i < outLen; i++) {
  const src = i * ratio;
  const i0 = Math.floor(src), i1 = Math.min(i0 + 1, pcm24.length / 2 - 1);
  const frac = src - i0;
  const s0 = pcm24.readInt16LE(i0 * 2), s1 = pcm24.readInt16LE(i1 * 2);
  pcm16.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
}
console.log('TTS audio ready:', pcm16.length, 'bytes @16k');

// 3) Open a Live session with the SAME config Safa uses
const session = await ai.live.connect({
  model: 'gemini-3.1-flash-live-preview',
  config: {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    inputAudioTranscription: { languageCodes: ['en-US', 'bn-BD'] },
    outputAudioTranscription: {},
  },
  callbacks: {
    onmessage: (msg) => {
      const sc = msg.serverContent;
      if (!sc) { console.log('MSG(no serverContent):', JSON.stringify(msg).slice(0, 120)); return; }
      const keys = Object.keys(sc).filter(k => sc[k] !== undefined && sc[k] !== false);
      const interesting = {
        keys,
        inputTranscription: sc.inputTranscription?.text,
        interim: sc.interimInputTranscription?.text,
        outputTranscription: sc.outputTranscription?.text,
        modelTurnParts: (sc.modelTurn?.parts || []).map(p => Object.keys(p)),
        userTurn: sc.userTurn ? JSON.stringify(sc.userTurn).slice(0, 100) : undefined,
        turnComplete: sc.turnComplete,
      };
      console.log('LIVE MSG:', JSON.stringify(interesting).slice(0, 400));
    },
    onerror: (e) => console.error('LIVE ERR:', e?.message || e),
    onclose: (e) => console.log('LIVE CLOSE:', e?.reason || ''),
  },
});

// 4) Stream the audio in ~100ms chunks, then wait for the transcript + reply
const CHUNK = 1600; // 50ms frames batched
for (let i = 0; i < pcm16.length; i += CHUNK) {
  session.sendRealtimeInput({ audio: { data: pcm16.subarray(i, i + CHUNK).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  await new Promise(r => setTimeout(r, 40));
}
console.log('Audio sent, waiting for transcripts...');
await new Promise(r => setTimeout(r, 25000));
session.close();
process.exit(0);
