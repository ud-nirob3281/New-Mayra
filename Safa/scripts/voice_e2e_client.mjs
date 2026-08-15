// Voice-path E2E: speak over the Safa WS bridge (real TTS audio), then verify
// persistence + reconnect-recall. Usage:
//   node scripts/voice_e2e_client.mjs speak <sessionId>
//   node scripts/voice_e2e_client.mjs ask <sessionId> "question text"
import fs from 'fs';
import { GoogleGenAI, Modality } from '@google/genai';

const mode = process.argv[2];
const sessionId = process.argv[3];
const question = process.argv[4] || 'What was the code word I told you? Answer in one line.';

const key = JSON.parse(fs.readFileSync(process.env.SECRETS, 'utf8')).geminiApiKey;
const ai = new GoogleGenAI({ apiKey: key });

const ws = new WebSocket(`ws://localhost:3000/live?sessionId=${sessionId}`);
const timeout = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);

if (mode === 'speak') {
  // 1) TTS the test utterance (24kHz PCM) — cached to avoid rate-limit churn
  const CACHE = (await import('os')).tmpdir() + '/safa_e2e_speech.bin';
  let pcm16;
  if (fs.existsSync(CACHE) && fs.statSync(CACHE).size > 10000) {
    pcm16 = fs.readFileSync(CACHE);
    console.log('Using cached speech audio:', pcm16.length, 'bytes');
  } else {
    let b64 = null;
    const ttsModels = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-tts', 'gemini-2.5-flash-lite-preview-tts'];
    for (let attempt = 1; attempt <= 9 && !b64; attempt++) {
      const model = ttsModels[(attempt - 1) % ttsModels.length];
      try {
        const tts = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: 'Say calmly: Hello Safa, please remember the code word GREEN FALCON ninety two.' }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          },
        });
        b64 = tts.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      } catch (e) {
        console.log(`TTS attempt ${attempt} failed: ${e?.message?.slice(0, 80)}, retrying...`);
        await new Promise(r => setTimeout(r, 8000 * attempt));
      }
    }
    if (!b64) { console.error('TTS failed after retries'); process.exit(1); }
    const pcm24 = Buffer.from(b64, 'base64');

    // amplitude sanity check
    let peak = 0;
    for (let i = 0; i + 1 < pcm24.length; i += 2) peak = Math.max(peak, Math.abs(pcm24.readInt16LE(i)));
    console.log('TTS 24k bytes:', pcm24.length, 'peak amplitude:', peak);

    // 2) resample 24k -> 16k
    const ratio = 24000 / 16000;
    const outLen = Math.floor(pcm24.length / 2 / ratio);
    pcm16 = Buffer.alloc(outLen * 2);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src), i1 = Math.min(i0 + 1, pcm24.length / 2 - 1);
      const frac = src - i0;
      const s0 = pcm24.readInt16LE(i0 * 2), s1 = pcm24.readInt16LE(i1 * 2);
      pcm16.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
    }
    fs.writeFileSync(CACHE, pcm16);
  }

  ws.onopen = () => {
    console.log('WS OPEN (speak mode)');
    (async () => {
      const CHUNK = 1600; // 50ms
      for (let i = 0; i < pcm16.length; i += CHUNK) {
        ws.send(JSON.stringify({ audio: pcm16.subarray(i, i + CHUNK).toString('base64') }));
        await new Promise(r => setTimeout(r, 40));
      }
      console.log('audio streamed, waiting for model reply...');
    })();
  };
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'transcription') console.log(`TRANSCRIPTION [${d.role}]:`, (d.text || '').slice(0, 100));
    if (d.type === 'audio') return;
    if (d.type === 'turnComplete') {
      console.log('TURN COMPLETE');
      clearTimeout(timeout);
      setTimeout(() => process.exit(0), 2500);
    }
  };
} else if (mode === 'ask') {
  ws.onopen = () => {
    console.log('WS OPEN (ask mode — new connection, same sessionId)');
    setTimeout(() => ws.send(JSON.stringify({ type: 'text', text: question })), 3000);
  };
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === 'transcription') console.log(`TRANSCRIPTION [${d.role}]:`, (d.text || '').slice(0, 120));
    if (d.type === 'audio') return;
    if (d.type === 'turnComplete') {
      console.log('TURN COMPLETE');
      clearTimeout(timeout);
      setTimeout(() => process.exit(0), 2500);
    }
  };
} else {
  console.error('usage: node voice_e2e_client.mjs speak|ask <sessionId> [question]');
  process.exit(1);
}
ws.onerror = (e) => console.log('WS ERROR', e.message || e);
