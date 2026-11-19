import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    engine: 'gemini-3.8-flash-with-groq-fallback',
    geminiCooldownRemainingMs: Math.max(0, geminiCooldownUntil - Date.now()),
  })
);

const upload = multer({ dest: 'uploads/' });

// Initialize Gemini via @google/genai
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY;
const ai = new GoogleGenAI({
  apiKey: geminiApiKey,
  httpOptions: {
    timeout: 60000,
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

const PRIMARY_GEMINI_MODEL = 'gemini-3.8-flash';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
const GROQ_LLM_PRIMARY = 'openai/gpt-oss-20b';
const GROQ_LLM_FALLBACK = 'qwen/qwen3.8-27b';

// In-memory cooldown timestamp to respect Gemini Free Tier 5 RPM and 503/429 spikes
let geminiCooldownUntil = 0;

function formatElapsedTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function extractJsonFromText(rawText: string): any {
  if (!rawText) return null;
  const cleaned = rawText.trim();
  const fenceRegex = new RegExp('\\x60\\x60\\x60(?:json)?\\s*([\\s\\S]*?)\\s*\\x60\\x60\\x60', 'i');
  const blockMatch = cleaned.match(fenceRegex);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1]);
    } catch {}
  }
  const objMatch = cleaned.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[1]);
    } catch {}
  }
  const arrMatch = cleaned.match(/(\[[\s\S]*\])/);
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
}

function getGroqApiKey(req: express.Request): string | null {
  const headerKey = req.header('x-groq-api-key');
  const key = (process.env.GROQ_API_KEY || headerKey || '').trim();
  return key || null;
}

function parseRetryDelayMs(err: any): number {
  const msg = String(err?.message || err || '');
  // Match "retryDelay":"18s" or "retry in 18.8s"
  const retryDelayMatch = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryDelayMatch) {
    return Math.ceil(parseFloat(retryDelayMatch[1]) * 1000) + 1000;
  }
  const retryInMatch = msg.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (retryInMatch) {
    return Math.ceil(parseFloat(retryInMatch[1]) * 1000) + 1000;
  }
  return 20000;
}

function isGeminiInCooldown(): boolean {
  return Date.now() < geminiCooldownUntil;
}

async function callGeminiPrimary(options: {
  contents: any;
  config?: any;
}): Promise<{ text: string; provider: 'gemini-3.8-flash' }> {
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  if (isGeminiInCooldown()) {
    const remaining = Math.ceil((geminiCooldownUntil - Date.now()) / 1000);
    throw new Error(`GEMINI_COOLDOWN: ${remaining}s remaining`);
  }

  // Reserve 5 RPM slot (+12500ms) immediately before/after call
  geminiCooldownUntil = Math.max(geminiCooldownUntil, Date.now() + 12500);

  try {
    const response = await ai.models.generateContent({
      model: PRIMARY_GEMINI_MODEL,
      contents: options.contents,
      config: options.config,
    });

    const text = response.text || '';
    if (!text.trim()) {
      throw new Error(`Model ${PRIMARY_GEMINI_MODEL} returned an empty response.`);
    }
    return { text, provider: 'gemini-3.8-flash' };
  } catch (err: any) {
    const status = Number(err?.status || err?.code || 0);
    const msg = String(err?.message || err || '');
    if (status === 429 || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      const delayMs = parseRetryDelayMs(err);
      geminiCooldownUntil = Math.max(geminiCooldownUntil, Date.now() + delayMs);
    } else if (status === 503 || msg.includes('503') || msg.includes('UNAVAILABLE')) {
      geminiCooldownUntil = Math.max(geminiCooldownUntil, Date.now() + 20000);
    }
    console.warn(`[Gemini] ${PRIMARY_GEMINI_MODEL} failed (${status || 'ERR'}): ${msg}`);
    throw err;
  }
}

async function callGroqWhisper(
  audioBuffer: Buffer,
  groqApiKey: string,
  mimeType = 'audio/wav',
  languageHint?: string
): Promise<{ text: string; language: string; avgNoSpeechProb: number; isSilence: boolean }> {
  const formData = new FormData();
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mpeg') ? 'mp3' : 'wav';
  const blob = new Blob([audioBuffer], { type: mimeType });
  formData.append('file', blob, `segment.${ext}`);
  formData.append('model', GROQ_WHISPER_MODEL);
  formData.append('response_format', 'verbose_json');
  formData.append('temperature', '0');
  if (languageHint && languageHint !== 'auto' && languageHint.length <= 5) {
    formData.append('language', languageHint);
  }

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq Whisper HTTP ${res.status}: ${errText}`);
  }

  const data: any = await res.json();
  const text = (data?.text || '').trim();
  const language = data?.language || 'Auto-detect';

  let avgNoSpeechProb = 0;
  if (Array.isArray(data?.segments) && data.segments.length > 0) {
    const sum = data.segments.reduce((acc: number, s: any) => acc + (Number(s?.no_speech_prob) || 0), 0);
    avgNoSpeechProb = sum / data.segments.length;
  }

  const isSilence = !text || avgNoSpeechProb > 0.75;
  return { text, language, avgNoSpeechProb, isSilence };
}

async function callGroqChatJson(
  systemPrompt: string,
  userPrompt: string,
  groqApiKey: string
): Promise<{ text: string; modelUsed: string }> {
  const candidates: Array<{ model: string; reasoning_effort: 'low' | 'none' }> = [
    { model: GROQ_LLM_PRIMARY, reasoning_effort: 'low' },
    { model: GROQ_LLM_FALLBACK, reasoning_effort: 'none' },
  ];

  let lastError: any = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: candidate.model,
          reasoning_effort: candidate.reasoning_effort,
          response_format: { type: 'json_object' },
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Groq Chat (${candidate.model}) HTTP ${res.status}: ${errText}`);
      }

      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content.trim()) {
        throw new Error(`Groq Chat (${candidate.model}) returned empty content.`);
      }
      return { text: content, modelUsed: candidate.model };
    } catch (err: any) {
      lastError = err;
      console.warn(`[Groq] ${candidate.model} failed: ${err?.message || err}`);
    }
  }

  throw lastError || new Error('All Groq LLM models failed.');
}

async function generateTextJsonWithFallback(options: {
  prompt: string;
  systemPrompt?: string;
  groqApiKey: string | null;
}): Promise<{ text: string; provider: 'gemini-3.8-flash' | 'groq-fallback' }> {
  try {
    const geminiRes = await callGeminiPrimary({
      contents: options.prompt,
      config: { responseMimeType: 'application/json', temperature: 0.1 },
    });
    return { text: geminiRes.text, provider: 'gemini-3.8-flash' };
  } catch (geminiErr: any) {
    if (!options.groqApiKey) {
      throw geminiErr;
    }
    const groqRes = await callGroqChatJson(
      options.systemPrompt || 'You are a strict JSON API. Return only valid JSON.',
      options.prompt,
      options.groqApiKey
    );
    return { text: groqRes.text, provider: 'groq-fallback' };
  }
}

// -------------------------------------------------------------
// POST /api/live-segment
// Unified Live VAD Audio -> Gemini 3.8 Flash Primary + Automatic Groq Fallback
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
    } = req.body || {};

    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing audioBase64 payload.' });
    }

    const groqApiKey = getGroqApiKey(req);
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

    const schemaDescription = `
REQUIRED STRICT JSON SCHEMA:
{
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
}

Previous intelligence state (preserve/refine incrementally with new evidence):
${JSON.stringify({
  caseTitle: currentAnalysis?.caseTitle || null,
  callerStatus: currentAnalysis?.callerStatus || 'Unknown',
  extractedLocation: currentAnalysis?.extractedLocation || null,
  locationStatus: currentAnalysis?.locationStatus || 'unknown',
  stressVulnerabilityIndex: currentAnalysis?.riskScore || 0,
})}
`;

    let parsed: any = null;
    let provider: 'gemini-3.8-flash' | 'groq-fallback' = 'gemini-3.8-flash';

    // 1) Try Gemini 3.8 Flash Native Audio if not in cooldown
    let shouldFallbackToGroq = isGeminiInCooldown() || !geminiApiKey;

    if (!shouldFallbackToGroq) {
      try {
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
You are an emergency helpline (NHAA 14566) real-time native-audio transcription, acoustic speaker diarization, and emergency triage intelligence engine.

Analyze the NEW LIVE SPEECH SEGMENT audio directly and return ONE strict JSON object.

1. SILENCE / NOISE GUARD
If the new audio segment contains ONLY background noise, breathing, static, or unintelligible non-speech sounds with NO spoken words, return "segments": [] and preserve the existing profiles and intelligence state. Never hallucinate words.

2. MULTILINGUAL TRANSCRIPTION & CODE-SWITCHING
${langHintNote}
In "originalText": transcribe verbatim in the NATIVE SCRIPT of every spoken language. If the speaker code-switches mid-sentence, preserve the exact native script + English words seamlessly.
In "englishText": provide a faithful, natural English translation preserving all emergency details, numbers, landmarks, and urgency.

3. 100% AUTOMATIC SPEAKER DIARIZATION ("Operator" vs "Caller")
If multiple people speak in this single audio segment, split them into separate sequential items in "segments".
Match speakers using ALL three signals together:
(A) Acoustic Voice Matching against stored profiles:
- Stored Operator Voice Profile: ${JSON.stringify(operatorVoiceProfile || 'Not yet established')}
- Stored Caller Voice Profile: ${JSON.stringify(callerVoiceProfile || 'Not yet established')}
(B) Emergency Helpline Role Cues ("Operator" vs "Caller").
(C) Retroactive Role Correction ("retroactiveRoleFix") reviewing the last 8 labeled turns:
${recentTurnsFormatted}

4. VOCAL + SEMANTIC EMERGENCY INTELLIGENCE
Compute Stress Vulnerability Index (0-100) from BOTH vocal/acoustic cues and semantic urgency. Extract any location into English.
${schemaDescription}
`;
        parts.push({ text: instructionPrompt });

        const geminiRes = await callGeminiPrimary({
          contents: { parts },
          config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        });

        parsed = extractJsonFromText(geminiRes.text);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Failed to parse structured JSON from Gemini audio response.');
        }
        provider = 'gemini-3.8-flash';
      } catch (geminiErr: any) {
        shouldFallbackToGroq = true;
        if (!groqApiKey) {
          throw geminiErr;
        }
      }
    }

    // 2) Automatic Groq Fallback (Whisper Turbo -> GPT-OSS-20B / Qwen3.8-27B)
    if (shouldFallbackToGroq) {
      if (!groqApiKey) {
        return res.status(503).json({
          error:
            'Gemini is in cooldown/unavailable and GROQ_API_KEY is not configured. Add a Groq API key via GROQ KEY or server env.',
        });
      }

      const wavBuffer = Buffer.from(audioBase64, 'base64');
      const whisper = await callGroqWhisper(wavBuffer, groqApiKey, mimeType, sourceLanguageHint);

      if (whisper.isSilence) {
        return res.json({
          provider: 'groq-fallback',
          modelUsed: GROQ_WHISPER_MODEL,
          segments: [],
          operatorVoiceProfile: operatorVoiceProfile || null,
          callerVoiceProfile: callerVoiceProfile || null,
          retroactiveRoleFix: null,
          sourceLanguage: currentAnalysis?.detectedLanguage || whisper.language || 'Auto-detect',
          callerStatus: currentAnalysis?.callerStatus || 'Unknown',
          geolocation: {
            extractedLocation: currentAnalysis?.extractedLocation ?? null,
            locationStatus: currentAnalysis?.locationStatus || 'unknown',
            location_estimate: currentAnalysis?.location_estimate || null,
          },
          stressVulnerabilityIndex: Number(currentAnalysis?.riskScore || 0),
          sviRationale: Array.isArray(currentAnalysis?.emotionalFactors) ? currentAnalysis.emotionalFactors : [],
          sentiment: currentAnalysis?.sentiment || 'Neutral',
          detectedRiskSignals: Array.isArray(currentAnalysis?.signals) ? currentAnalysis.signals : [],
          suggestedQuestions: Array.isArray(currentAnalysis?.suggestedQuestions)
            ? currentAnalysis.suggestedQuestions
            : [],
          recommendedActions: Array.isArray(currentAnalysis?.recommendedActions)
            ? currentAnalysis.recommendedActions
            : [],
          caseTitle: currentAnalysis?.caseTitle || null,
        });
      }

      const groqPrompt = `
You are an emergency helpline (NHAA 14566) real-time diarization, multilingual translation, and emergency triage intelligence engine.

A new speech segment was transcribed by Whisper:
- Raw Transcript: ${JSON.stringify(whisper.text)}
- Detected Language: ${JSON.stringify(whisper.language)}
- Call Timestamp: ${defaultTimestamp}
- ${langHintNote}

Stored Speaker Voice Profiles (preserve/update):
- Operator Voice Profile: ${JSON.stringify(operatorVoiceProfile || 'Not yet established')}
- Caller Voice Profile: ${JSON.stringify(callerVoiceProfile || 'Not yet established')}

Last 8 Labeled Transcript Turns:
${recentTurnsFormatted}

INSTRUCTIONS:
1. Diarize the new transcript into one or more sequential "segments" labeled "Operator" or "Caller" based on helpline role cues and conversational turn-taking.
2. Preserve native script in "originalText" and provide accurate natural English in "englishText".
3. If an earlier turn in the last 8 turns was mislabeled, set "retroactiveRoleFix" to { "turnIndex": <number>, "correctedSpeaker": "Operator" | "Caller", "reason": "<brief reason>" }; otherwise null.
4. Compute "stressVulnerabilityIndex" (0-100), "sentiment", "callerStatus", "geolocation", "detectedRiskSignals", "suggestedQuestions", "recommendedActions", and "caseTitle".
${schemaDescription}
`;

      const groqChat = await callGroqChatJson(
        'You are a strict JSON emergency triage & diarization engine. Output ONLY a valid JSON object matching the requested schema.',
        groqPrompt,
        groqApiKey
      );

      parsed = extractJsonFromText(groqChat.text);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Failed to parse structured JSON from Groq fallback response.');
      }
      provider = 'groq-fallback';
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
      provider,
      modelUsed: provider,
      segments,
      operatorVoiceProfile: parsed.operatorVoiceProfile || operatorVoiceProfile || null,
      callerVoiceProfile: parsed.callerVoiceProfile || callerVoiceProfile || null,
      retroactiveRoleFix:
        parsed.retroactiveRoleFix && typeof parsed.retroactiveRoleFix.turnIndex === 'number'
          ? {
              turnIndex: parsed.retroactiveRoleFix.turnIndex,
              correctedSpeaker: parsed.retroactiveRoleFix.correctedSpeaker === 'Operator' ? 'Operator' : 'Caller',
              reason: parsed.retroactiveRoleFix.reason || 'Conversational role refinement',
            }
          : null,
      sourceLanguage: parsed.sourceLanguage || 'Auto-detect',
      callerStatus: parsed.callerStatus || 'Unknown',
      geolocation: {
        extractedLocation: geo.extractedLocation ?? parsed.extractedLocation ?? null,
        locationStatus: geo.locationStatus || 'unknown',
        location_estimate: geo.location_estimate || null,
      },
      extractedLocation: geo.extractedLocation ?? parsed.extractedLocation ?? null,
      locationConfidence: geo.location_estimate?.confidence || 'unknown',
      stressVulnerabilityIndex: svi,
      riskScore: svi,
      sviRationale: Array.isArray(parsed.sviRationale) ? parsed.sviRationale : [],
      sentiment: parsed.sentiment || 'Neutral',
      detectedRiskSignals: Array.isArray(parsed.detectedRiskSignals)
        ? parsed.detectedRiskSignals
        : Array.isArray(parsed.signals)
        ? parsed.signals
        : [],
      signals: Array.isArray(parsed.detectedRiskSignals)
        ? parsed.detectedRiskSignals
        : Array.isArray(parsed.signals)
        ? parsed.signals
        : [],
      suggestedQuestions: Array.isArray(parsed.suggestedQuestions) ? parsed.suggestedQuestions : [],
      recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions : [],
      caseTitle: parsed.caseTitle || null,
    });
  } catch (error: any) {
    console.error('[LiveSegment] Error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Live audio processing failed' });
  }
});

// -------------------------------------------------------------
// REST Endpoint: Analyze Transcript (Gemini 3.8 Flash -> Groq Fallback)
// -------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  try {
    const { turns, sourceLanguage } = req.body;
    if (!turns || turns.length === 0) {
      return res.json({
        provider: 'gemini-3.8-flash',
        riskScore: 0,
        signals: [],
        recommendedActions: [],
        suggestedQuestions: [],
        callerStatus: 'Unknown',
        locationStatus: 'Unknown',
        translations: {},
        correctedOriginals: {},
      });
    }

    const groqApiKey = getGroqApiKey(req);
    const transcriptText = turns
      .map((t: any, index: number) => `[Turn ${index}] ${t.speaker}: ${t.originalText || t.text}`)
      .join('\n');

    const targetLangInstruction =
      sourceLanguage && sourceLanguage !== 'auto'
        ? `\nExpected caller language hint: ${sourceLanguage}. Preserve native script in 'correctedOriginals' and accurate English in 'translations'.`
        : '';

    const prompt = `
You are an emergency CAD operator AI assistant (NHAA 14566). Analyze this conversation transcript and return a strict JSON object.${targetLangInstruction}

{
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
}

Transcript:
${transcriptText}
`;

    let parsedReport: any = {
      provider: 'gemini-3.8-flash',
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
      const { text, provider } = await generateTextJsonWithFallback({
        prompt,
        groqApiKey,
      });
      const extracted = extractJsonFromText(text);
      if (extracted && typeof extracted === 'object') {
        parsedReport = { ...parsedReport, ...extracted, provider };
      }
    } catch (apiError: any) {
      console.warn('Analysis fallback error:', apiError?.message || apiError);
      return res.json(parsedReport);
    }

    return res.json(parsedReport);
  } catch (error: any) {
    console.error('Analysis Endpoint Error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Failed to analyze transcript' });
  }
});

// -------------------------------------------------------------
// REST Endpoint: Translate Entire Transcript (Gemini 3.8 Flash -> Groq Fallback)
// -------------------------------------------------------------
app.post('/api/translate', async (req, res) => {
  try {
    const { turns } = req.body;
    if (!turns || turns.length === 0) {
      return res.json({ translations: {}, provider: 'gemini-3.8-flash' });
    }

    const groqApiKey = getGroqApiKey(req);
    const transcriptText = turns
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
}

Transcript:
${transcriptText}
`;

    const { text, provider } = await generateTextJsonWithFallback({
      prompt,
      groqApiKey,
    });

    const parsed = extractJsonFromText(text) || { translations: {} };
    return res.json({ ...parsed, provider });
  } catch (error: any) {
    console.error('Translation Endpoint Error:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'Failed to translate transcript' });
  }
});

// -------------------------------------------------------------
// REST Endpoint: File Upload Transcription (Gemini 3.8 Flash -> Groq Fallback)
// -------------------------------------------------------------
app.post('/api/transcribe_file', upload.single('file'), async (req, res) => {
  let filePath: string | null = null;
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    filePath = file.path;
    const groqApiKey = getGroqApiKey(req);
    const fileBuffer = fs.readFileSync(file.path);
    const base64Data = fileBuffer.toString('base64');

    const prompt = `
Listen carefully to this emergency audio file and return a strict JSON object with word-for-word multilingual diarized transcription and English translation.

CRITICAL INSTRUCTIONS:
1. DIARIZATION: Separate every speaker change into alternating turns between "Operator" (helpline agent) and "Caller" (person calling).
2. NATIVE SCRIPT & CODE-SWITCHING: Transcribe "originalText" verbatim in the native script of the spoken language(s), preserving mid-sentence code-switching.
3. TRANSLATION: Provide accurate English translation in "englishText" for every turn.

OUTPUT STRICT JSON:
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
`;

    let parsed: any = null;
    let provider: 'gemini-3.8-flash' | 'groq-fallback' = 'gemini-3.8-flash';

    try {
      const geminiRes = await callGeminiPrimary({
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
      });
      parsed = extractJsonFromText(geminiRes.text);
      provider = 'gemini-3.8-flash';
    } catch (geminiErr: any) {
      if (!groqApiKey) {
        throw geminiErr;
      }
      const whisper = await callGroqWhisper(fileBuffer, groqApiKey, file.mimetype || 'audio/wav');
      if (whisper.isSilence) {
        return res.json({ turns: [], language: whisper.language, speaker_count_detected: 0, provider: 'groq-fallback' });
      }
      const groqChat = await callGroqChatJson(
        'You are a strict JSON diarization and translation engine.',
        `${prompt}\n\nRaw Whisper Transcript (${whisper.language}):\n${whisper.text}`,
        groqApiKey
      );
      parsed = extractJsonFromText(groqChat.text);
      provider = 'groq-fallback';
    }

    const rawTurns = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.turns)
      ? parsed.turns
      : [];

    const turns = rawTurns.map((t: any, idx: number) => {
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
    });

    return res.json({
      provider,
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
});

// -------------------------------------------------------------
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
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT} (Gemini 3.8 Flash + Groq Fallback Active)`);
  });
}

startServer();
