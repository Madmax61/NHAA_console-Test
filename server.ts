import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';const app = express();
const PORT = 3000;app.use(express.json({ limit: '25mb' }));app.get('/health', (_req, res) => res.json({ status: 'ok', engine: 'gemini-native-audio' }));const upload = multer({ dest: 'uploads/' });// Initialize Gemini via @google/genai
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
const ai = new GoogleGenAI({
apiKey: geminiApiKey,
httpOptions: {
timeout: 60000,
headers: {
'User-Agent': 'aistudio-build',
},
},
});const PRIMARY_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODEL = 'gemini-2.0-flash';function formatElapsedTimestamp(seconds: number): string {
const safe = Math.max(0, Math.floor(seconds || 0));
const m = Math.floor(safe / 60);
const s = safe % 60;
return ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')};
}function extractJsonFromText(rawText: string): any {
if (!rawText) return null;
const cleaned = rawText.trim();
const blockMatch = cleaned.match(/json\s*([\s\S]*?)\s*/i);
if (blockMatch) {
try {
return JSON.parse(blockMatch[1]);
} catch {}
}
const objMatch = cleaned.match(/({[\s\S]*})/);
if (objMatch) {
try {
return JSON.parse(objMatch[1]);
} catch {}
}
const arrMatch = cleaned.match(/([\s§]∗[\s\S]*[\s§]∗)/);
if (arrMatch) {
try {
return JSON.parse(arrMatch[1]);
} catch {}
}
try {
return JSON.parse(cleaned);
} catch {
return null;
}
}async function generateWithGeminiFallback(options: {
contents: any;
config?: any;
models?: string[];
}): Promise<{ text: string; modelUsed: string }> {
if (!geminiApiKey) {
throw new Error('GEMINI_API_KEY is not configured on the server.');
}const models = options.models || [PRIMARY_MODEL, FALLBACK_MODEL];
let lastError: any = null;for (const model of models) {
try {
const response = await ai.models.generateContent({
model,
contents: options.contents,
config: options.config,
});  const text = response.text || '';
  if (!text.trim()) {
    throw new Error(`Model ${model} returned an empty response.`);
  }
  return { text, modelUsed: model };
} catch (err: any) {
  lastError = err;
  const status = err?.status || err?.code || 'ERR';
  console.warn(`[Gemini] ${model} failed (${status}): ${err?.message || err}`);
  if (err?.status === 400) {
    throw err;
  }
  // On 429 rate limit, 503 overload, or transient error, immediately fall back to next model
}
}throw lastError || new Error('All Gemini models failed.');
}// -------------------------------------------------------------
// POST /api/live-segment
// Unified Live VAD Audio -> Diarization + Multilingual Transcription + Intelligence
// -------------------------------------------------------------
app.post('/api/live-segment', async (req, res) => {
try {
const {
audioBase64,
mimeType = 'audio/wav',
elapsedSeconds = 0,
sourceLanguageHint = 'auto',
operatorVoiceProfile = null,
callerVoiceProfile = null,
operatorRefAudioBase64 = null,
callerRefAudioBase64 = null,
previousTailAudioBase64 = null,
recentTurns = [],
currentAnalysis = {},
} = req.body || {};if (!audioBase64 || typeof audioBase64 !== 'string') {
  return res.status(400).json({ error: 'Missing audioBase64 payload.' });
}

const defaultTimestamp = formatElapsedTimestamp(elapsedSeconds);
const recentTurnsFormatted =
  Array.isArray(recentTurns) && recentTurns.length > 0
    ? recentTurns
        .slice(-8)
        .map(
          (t: any) =>
            `[TurnIndex ${t.turnIndex}] [${t.timestamp || '00:00'}] ${t.speaker}: "${t.originalText || t.text}"${
              t.englishText && t.englishText !== (t.originalText || t.text) ? ` (EN: "${t.englishText}")` : ''
            }`
        )
        .join('\n')
    : 'None yet (this is the opening of the call).';

const langHintNote =
  sourceLanguageHint && sourceLanguageHint !== 'auto'
    ? `Operator selected language hint: "${sourceLanguageHint}", though you MUST still automatically detect the true spoken language(s) and any mid-sentence code-switching.`
    : 'Automatically detect the spoken language(s) and any mid-sentence code-switching across ALL languages (Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Punjabi, Kannada, Malayalam, Urdu, English, Hinglish, etc.).';

const parts: any[] = [];

if (operatorRefAudioBase64) {
  parts.push({
    text: 'ACOUSTIC REFERENCE AUDIO — CONFIRMED "Operator" VOICE (match against this voice timbre/pitch/cadence):',
  });
  parts.push({
    inlineData: {
      data: operatorRefAudioBase64,
      mimeType: 'audio/wav',
    },
  });
}

if (callerRefAudioBase64) {
  parts.push({
    text: 'ACOUSTIC REFERENCE AUDIO — CONFIRMED "Caller" VOICE (match against this voice timbre/pitch/cadence):',
  });
  parts.push({
    inlineData: {
      data: callerRefAudioBase64,
      mimeType: 'audio/wav',
    },
  });
}

if (previousTailAudioBase64) {
  parts.push({
    text: 'SHORT ROLLING AUDIO OVERLAP (~0.95s tail of the immediately preceding utterance for acoustic continuity ONLY — do NOT re-transcribe words already captured in the last turn):',
  });
  parts.push({
    inlineData: {
      data: previousTailAudioBase64,
      mimeType: 'audio/wav',
    },
  });
}

parts.push({
  text: `NEW LIVE SPEECH SEGMENT TO TRANSCRIBE, DIARIZE, AND ANALYZE (Call timestamp: ${defaultTimestamp}):`,
});
parts.push({
  inlineData: {
    data: audioBase64,
    mimeType,
  },
});

const instructionPrompt = `
You are an emergency helpline (NHAA 14566) real-time native-audio transcription, acoustic speaker diarization, and emergency triage intelligence engine.Analyze the NEW LIVE SPEECH SEGMENT audio directly and return ONE strict JSON object.1. SILENCE / NOISE GUARDIf the new audio segment contains ONLY background noise, breathing, static, or unintelligible non-speech sounds with NO spoken words, return "segments": [] and preserve the existing profiles and intelligence state. Never hallucinate words.2. MULTILINGUAL TRANSCRIPTION & CODE-SWITCHING${langHintNote}In "originalText": transcribe verbatim in the NATIVE SCRIPT of every spoken language (e.g., Devanagari for Hindi/Marathi, Bengali script for Bengali, Tamil script for Tamil, Telugu script for Telugu, etc.). If the speaker code-switches mid-sentence (e.g., Hinglish, Banglish, Tanglish), preserve the exact native script + English words seamlessly.In "englishText": provide a faithful, natural English translation preserving all emergency details, numbers, landmarks, and urgency. If already English, repeat the English text cleanly.3. 100% AUTOMATIC SPEAKER DIARIZATION ("Operator" vs "Caller")If multiple people speak in this single audio segment, split them into separate sequential items in "segments".Match speakers using ALL three signals together:
(A) Acoustic Voice Matching: Compare the voice(s) in the new audio against the Acoustic Reference Audio clips (if provided) and the stored voice profiles below:
- Stored Operator Voice Profile: ${JSON.stringify(operatorVoiceProfile || 'Not yet established')}
- Stored Caller Voice Profile: ${JSON.stringify(callerVoiceProfile || 'Not yet established')}
(B) Emergency Helpline Role Cues:
- "Operator": Helpline agent/dispatcher conducting intake, greetings ("14566 helpline", "Hello, how can I help?"), calm triage questions ("What is your location?", "Are you safe?"), reassurance, dispatch updates.
- "Caller": Citizen/victim reporting an emergency, expressing distress/panic/urgency, answering triage questions, describing threats, injuries, or location.
(C) Retroactive Role Correction ("retroactiveRoleFix"):
- Review the last 8 labeled transcript turns below:
${recentTurnsFormatted}
- If an earlier opening line (such as "Hello?" or "Haan?") was ambiguous and tentatively mislabeled, and this new segment's voice acoustics or role cues prove the earlier turn belonged to the other speaker, set "retroactiveRoleFix" to { "turnIndex": , "correctedSpeaker": "Operator" | "Caller", "reason": "" } and update both voice profiles accordingly. Otherwise set "retroactiveRoleFix": null.4. VOCAL + SEMANTIC EMERGENCY INTELLIGENCEStress Vulnerability Index ("stressVulnerabilityIndex", 0-100): Compute from BOTH:Vocal & acoustic cues in the audio: voice pitch elevation, tremor/shakiness, crying/sobbing, shouting/screaming, rapid/gasping breath, panic, and background distress sounds (sirens, alarms, yelling, crashing, traffic).Semantic urgency in the conversation (active violence, fire, medical emergency, self-harm, trapped caller).Geolocation: Extract any address, landmark, road, station, locality, or city mentioned across the conversation (translated to English in "extractedLocation"). Provide realistic coordinates in "location_estimate" when a real place is mentioned, or null if unknown.REQUIRED STRICT JSON SCHEMA{
"segments": [
{
"speaker": "Operator" | "Caller",
"originalText": "string (verbatim native script)",
"englishText": "string (accurate English translation)",
"detectedLanguage": "string (e.g. Hindi, Bengali, Tamil, English, Hinglish)",
"timestamp": "${defaultTimestamp}",
"confidence": 0.95
}
],
"operatorVoiceProfile": {
"pitch": "string (e.g. medium-low, steady)",
"timbre": "string (e.g. clear, calm, resonant)",
"micDistance": "string (e.g. close headset mic, low reverb)",
"speakingCadence": "string (e.g. measured, structured)",
"summary": "string (concise 1-line acoustic signature)"
},
"callerVoiceProfile": {
"pitch": "string (e.g. high, strained)",
"timbre": "string (e.g. breathless, trembling)",
"micDistance": "string (e.g. mobile phone speaker, outdoor ambient noise)",
"speakingCadence": "string (e.g. rapid, fragmented)",
"summary": "string (concise 1-line acoustic signature)"
},
"retroactiveRoleFix": null,
"sourceLanguage": "string (primary caller language detected)",
"callerStatus": "string (e.g. In Immediate Danger, Distressed, Injured, Reporting Incident, Calm)",
"geolocation": {
"extractedLocation": "string | null (English address/landmark)",
"locationStatus": "unknown" | "approximate" | "known",
"location_estimate": {
"confidence": "unknown" | "insufficient" | "low" | "medium" | "high",
"confidenceScore": 0,
"latitude": null,
"longitude": null,
"radiusMeters": 1000,
"label": "string",
"source": "Caller-stated location clue",
"isVerified": false,
"evidence": ["string"]
}
},
"stressVulnerabilityIndex": 0,
"sviRationale": ["string (vocal and semantic stress factors)"],
"sentiment": "string (e.g. Panicked, Urgent, Anxious, Calm)",
"detectedRiskSignals": [
{ "category": "string", "keyword": "string", "description": "string" }
],
"suggestedQuestions": ["string (2-4 high-priority next questions not yet answered)"],
"recommendedActions": ["string (2-4 concrete emergency response actions)"],
"caseTitle": "string (2-4 word incident title)"
}Previous intelligence state (preserve/refine incrementally with new evidence):
${JSON.stringify({
caseTitle: currentAnalysis?.caseTitle || null,
callerStatus: currentAnalysis?.callerStatus || 'Unknown',
extractedLocation: currentAnalysis?.extractedLocation || null,
locationStatus: currentAnalysis?.locationStatus || 'unknown',
stressVulnerabilityIndex: currentAnalysis?.riskScore || 0,
})}
`;parts.push({ text: instructionPrompt });

const { text, modelUsed } = await generateWithGeminiFallback({
  models: [PRIMARY_MODEL, FALLBACK_MODEL],
  contents: { parts },
  config: {
    responseMimeType: 'application/json',
    temperature: 0.1,
  },
});

const parsed = extractJsonFromText(text);
if (!parsed || typeof parsed !== 'object') {
  throw new Error('Failed to parse structured JSON from Gemini audio response.');
}

const segments = Array.isArray(parsed.segments)
  ? parsed.segments
      .filter((s: any) => s && typeof s.originalText === 'string' && s.originalText.trim().length > 0)
      .map((s: any) => ({
        speaker: s.speaker === 'Operator' ? 'Operator' : 'Caller',
        originalText: s.originalText.trim(),
        englishText: (s.englishText || s.originalText).trim(),
        detectedLanguage: s.detectedLanguage || parsed.sourceLanguage || 'Auto',
        timestamp: s.timestamp || defaultTimestamp,
        confidence: typeof s.confidence === 'number' ? s.confidence : 0.9,
      }))
  : [];

const geo = parsed.geolocation || {};
const svi = Math.max(0, Math.min(100, Number(parsed.stressVulnerabilityIndex ?? parsed.riskScore ?? 0) || 0));

return res.json({
  modelUsed,
  segments,
  operatorVoiceProfile: parsed.operatorVoiceProfile || operatorVoiceProfile || null,
  callerVoiceProfile: parsed.callerVoiceProfile || callerVoiceProfile || null,
  retroactiveRoleFix:
    parsed.retroactiveRoleFix && typeof parsed.retroactiveRoleFix.turnIndex === 'number'
      ? {
          turnIndex: parsed.retroactiveRoleFix.turnIndex,
          correctedSpeaker: parsed.retroactiveRoleFix.correctedSpeaker === 'Operator' ? 'Operator' : 'Caller',
          reason: parsed.retroactiveRoleFix.reason || 'Acoustic & conversational role refinement',
        }
      : null,
  sourceLanguage: parsed.sourceLanguage || 'Auto-detect',
  callerStatus: parsed.callerStatus || 'Unknown',
  geolocation: {
    extractedLocation: geo.extractedLocation ?? null,
    locationStatus: geo.locationStatus || 'unknown',
    location_estimate: geo.location_estimate || null,
  },
  stressVulnerabilityIndex: svi,
  sviRationale: Array.isArray(parsed.sviRationale) ? parsed.sviRationale : [],
  sentiment: parsed.sentiment || 'Neutral',
  detectedRiskSignals: Array.isArray(parsed.detectedRiskSignals) ? parsed.detectedRiskSignals : [],
  suggestedQuestions: Array.isArray(parsed.suggestedQuestions) ? parsed.suggestedQuestions : [],
  recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions : [],
  caseTitle: parsed.caseTitle || null,
});
} catch (error: any) {
console.error('[LiveSegment] Error:', error?.message || error);
return res.status(500).json({ error: error?.message || 'Live audio processing failed' });
}
});// -------------------------------------------------------------
// REST Endpoint: Analyze Transcript (Fallback / Uploaded File Analysis)
// -------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
try {
const { turns, sourceLanguage } = req.body;
if (!turns || turns.length === 0) {
return res.json({
riskScore: 0,
signals: [],
recommendedActions: [],
suggestedQuestions: [],
callerStatus: 'Unknown',
locationStatus: 'Unknown',
translations: {},
correctedOriginals: {},
});
}const transcriptText = turns
  .map((t: any, index: number) => `[Turn ${index}] ${t.speaker}: ${t.originalText || t.text}`)
  .join('\n');

const targetLangInstruction =
  sourceLanguage && sourceLanguage !== 'auto'
    ? `\nExpected caller language hint: ${sourceLanguage}. Preserve native script in 'correctedOriginals' and accurate English in 'translations'.`
    : '';

const prompt = `
You are an emergency CAD operator AI assistant (NHAA 14566). Analyze this conversation transcript and return a strict JSON object.${targetLangInstruction}{
"caseTitle": "string (2-4 word summary)",
"riskScore": 0,
"signals": [{"category": "string", "keyword": "string", "description": "string"}],
"emotionalFactors": ["string"],
"sentiment": "string",
"recommendedActions": ["string"],
"suggestedQuestions": ["string"],
"callerStatus": "string",
"locationStatus": "unknown" | "approximate" | "known",
"extractedLocation": "string | null (in English)",
"location_estimate": {
"confidence": "unknown" | "insufficient" | "low" | "medium" | "high",
"confidenceScore": 0,
"latitude": null,
"longitude": null,
"radiusMeters": 1000,
"label": "string",
"source": "Caller-stated location clue",
"isVerified": false,
"evidence": ["string"]
},
"detectedLanguage": "string | null",
"translations": { "0": "English translation for Turn 0" },
"correctedOriginals": { "0": "Corrected native script if needed" }
}Transcript:
${transcriptText}
`;let parsedReport: any = {
  riskScore: 0,
  signals: [],
  emotionalFactors: [],
  sentiment: 'Neutral',
  recommendedActions: [],
  suggestedQuestions: [],
  callerStatus: 'Unknown',
  locationStatus: 'Unknown',
  extractedLocation: null,
  detectedLanguage: null,
  translations: {},
  correctedOriginals: {},
};

try {
  const { text } = await generateWithGeminiFallback({
    models: [PRIMARY_MODEL, FALLBACK_MODEL],
    contents: prompt,
    config: { responseMimeType: 'application/json', temperature: 0.1 },
  });
  const extracted = extractJsonFromText(text);
  if (extracted && typeof extracted === 'object') {
    parsedReport = { ...parsedReport, ...extracted };
  }
} catch (apiError: any) {
  console.warn('Analysis fallback:', apiError?.message || apiError);
  return res.json(parsedReport);
}

return res.json(parsedReport);
} catch (error: any) {
console.error('Analysis Endpoint Error:', error?.message || error);
return res.status(500).json({ error: error?.message || 'Failed to analyze transcript' });
}
});// -------------------------------------------------------------
// REST Endpoint: Translate Entire Transcript
// -------------------------------------------------------------
app.post('/api/translate', async (req, res) => {
try {
const { turns } = req.body;
if (!turns || turns.length === 0) {
return res.json({ translations: {} });
}const transcriptText = turns
  .map((t: any, i: number) => `[Turn ${i}] ${t.speaker}: ${t.originalText || t.text}`)
  .join('\n');

const prompt = `
You are an expert emergency services translator.
Translate each turn of the following multilingual transcript into natural, accurate English while preserving exact urgency, addresses, and details.
If a turn is already in English, output the English text cleanly.
Return strict JSON:
{
"translations": {
"0": "English text for Turn 0",
"1": "English text for Turn 1"
}
}Transcript:
${transcriptText}
`;const { text } = await generateWithGeminiFallback({
  models: [PRIMARY_MODEL, FALLBACK_MODEL],
  contents: prompt,
  config: { responseMimeType: 'application/json', temperature: 0.1 },
});

const parsed = extractJsonFromText(text) || { translations: {} };
return res.json(parsed);
} catch (error: any) {
console.error('Translation Endpoint Error:', error?.message || error);
return res.status(500).json({ error: error?.message || 'Failed to translate transcript' });
}
});// -------------------------------------------------------------
// REST Endpoint: File Upload Transcription (Using Gemini Native Audio)
// -------------------------------------------------------------
app.post('/api/transcribe_file', upload.single('file'), async (req, res) => {
let filePath: string | null = null;
const file = req.file;
if (!file) {
return res.status(400).json({ error: 'No file uploaded' });
}try {
filePath = file.path;
const fileBuffer = fs.readFileSync(file.path);
const base64Data = fileBuffer.toString('base64');const prompt = `
Listen carefully to this emergency audio file and return a strict JSON object with word-for-word multilingual diarized transcription and English translation.CRITICAL INSTRUCTIONS:DIARIZATION: Separate every speaker change into alternating turns between "Operator" (helpline agent) and "Caller" (person calling).NATIVE SCRIPT & CODE-SWITCHING: Transcribe "originalText" verbatim in the native script of the spoken language(s) (Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Punjabi, English, Hinglish, etc.), preserving mid-sentence code-switching.TRANSLATION: Provide accurate English translation in "englishText" for every turn.OUTPUT STRICT JSON:
{
"detectedLanguage": "string",
"turns": [
{
"speaker": "Operator" | "Caller",
"start": 0.0,
"end": 2.5,
"timestamp": "00:00",
"originalText": "string",
"englishText": "string",
"detectedLanguage": "string",
"confidence": 0.95,
"isFinal": true
}
]
}
`;const { text } = await generateWithGeminiFallback({
models: [PRIMARY_MODEL, FALLBACK_MODEL],
contents: {
parts: [
{ inlineData: { data: base64Data, mimeType: file.mimetype || 'audio/wav' } },
{ text: prompt },
],
},
config: {
responseMimeType: 'application/json',
temperature: 0.1,
},
});const parsed = extractJsonFromText(text);
const rawTurns = Array.isArray(parsed)
? parsed
: Array.isArray(parsed?.turns)
? parsed.turns
: [];const turns = rawTurns.map((t: any, idx: number) => {
const startSec = typeof t.start === 'number' ? t.start : idx * 3;
const orig = (t.originalText || t.text || '').trim();
const eng = (t.englishText || orig).trim();
return {
id: Date.now() + idx,
speaker: t.speaker === 'Operator' ? 'Operator' : 'Caller',
start: startSec,
end: typeof t.end === 'number' ? t.end : startSec + 2.5,
timestamp: t.timestamp || formatElapsedTimestamp(startSec),
text: orig,
originalText: orig,
englishText: eng,
detectedLanguage: t.detectedLanguage || parsed?.detectedLanguage || 'Auto',
confidence: typeof t.confidence === 'number' ? t.confidence : 0.92,
isFinal: true,
};
});return res.json({
turns,
language: parsed?.detectedLanguage || null,
speaker_count_detected: new Set(turns.map((t: any) => t.speaker)).size,
});
} catch (error: any) {
console.error('File Transcription Error:', error?.message || error);
return res.status(500).json({ error: error?.message || 'Failed to transcribe uploaded file', turns: [] });
} finally {
if (filePath && fs.existsSync(filePath)) {
try {
fs.unlinkSync(filePath);
} catch {}
}
}
});// -------------------------------------------------------------
// HTTP / Vite integration setup
// -------------------------------------------------------------
async function startServer() {
if (process.env.NODE_ENV !== 'production') {
const vite = await createViteServer({
server: { middlewareMode: true },
appType: 'spa',
});
app.use(vite.middlewares);
} else {
const distPath = path.join(process.cwd(), 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}app.listen(PORT, '0.0.0.0', () => {
console.log(Server running on [http://0.0.0.0](http://0.0.0.0):${PORT} (Gemini Native Audio Pipeline Active));
});
}startServer();
