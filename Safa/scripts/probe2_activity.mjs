// Probe 2: same Live config as Safa. (a) stream cached speech with
// activityStart/activityEnd markers; (b) then send a text turn — to tell
// whether the session works at all vs VAD-specific trouble.
import fs from 'fs';
import { GoogleGenAI, Modality } from '@google/genai';

const key = JSON.parse(fs.readFileSync(process.env.SECRETS, 'utf8')).geminiApiKey;
const ai = new GoogleGenAI({ apiKey: key });
const pcm16 = fs.readFileSync(process.env.LOCALAPPDATA + '/Temp/safa_e2e_speech.bin');
console.log('speech bytes:', pcm16.length);

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
      if (!sc) { console.log('MSG:', JSON.stringify(msg).slice(0, 150)); return; }
      console.log('SC:', JSON.stringify({
        inputT: sc.inputTranscription,
        interimT: sc.interimInputTranscription,
        outputT: sc.outputTranscription,
        partsText: (sc.modelTurn?.parts || []).map(p => p.text).filter(Boolean),
        turnComplete: sc.turnComplete,
        interrupted: sc.interrupted,
      }).slice(0, 300));
    },
    onerror: (e) => console.error('LIVE ERR:', e?.message || e),
    onclose: (e) => console.log('LIVE CLOSE:', e?.reason || ''),
  },
});

// (a) audio with activity markers
try { session.sendRealtimeInput({ activityStart: {} }); } catch (e) { console.log('activityStart err', e.message); }
const CHUNK = 1600;
for (let i = 0; i < pcm16.length; i += CHUNK) {
  session.sendRealtimeInput({ audio: { data: pcm16.subarray(i, i + CHUNK).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  await new Promise(r => setTimeout(r, 40));
}
try { session.sendRealtimeInput({ activityEnd: {} }); } catch (e) { console.log('activityEnd err', e.message); }
console.log('audio sent (+activity markers), waiting 15s...');
await new Promise(r => setTimeout(r, 15000));

// (b) text turn to verify session responsiveness
session.sendClientContent({ turns: { role: 'user', parts: [{ text: 'Reply with exactly: PONG' }] }, turnComplete: true });
console.log('text sent, waiting 15s...');
await new Promise(r => setTimeout(r, 15000));
session.close();
process.exit(0);
