export type VadStatus = 'idle' | 'monitoring' | 'speech';

export interface VadSegmentPayload {
  audioBase64: string;
  tailAudioBase64: string;
  durationMs: number;
  elapsedSeconds: number;
}

export interface VadCaptureCallbacks {
  onVadStatusChange: (status: VadStatus) => void;
  onAudioLevel: (rms: number) => void;
  onSpeechSegment: (segment: VadSegmentPayload) => void;
  onError: (message: string) => void;
}

const TARGET_SAMPLE_RATE = 16000;
const PRE_SPEECH_MS = 450;
const HANGOVER_MS = 850;
const MIN_SPEECH_MS = 350;
const MAX_SEGMENT_MS = 12000;
const OVERLAP_TAIL_MS = 950;

const WORKLET_CODE = `
class VadPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const copy = new Float32Array(input[0].length);
      copy.set(input[0]);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('vad-pcm-processor', VadPcmProcessor);
`;

function downsampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return input;
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  if (outputLength <= 0) return new Float32Array(0);

  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    output[i] = count > 0 ? sum / count : input[start] || 0;
  }
  return output;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

export function encodeWav16kMonoBase64(samples: Float32Array): string {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF header
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');

  // fmt chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat: PCM = 1
  view.setUint16(22, 1, true); // NumChannels: Mono = 1
  view.setUint32(24, TARGET_SAMPLE_RATE, true); // SampleRate: 16000
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true); // ByteRate: SampleRate * NumChannels * BitsPerSample/8
  view.setUint16(32, 2, true); // BlockAlign: NumChannels * BitsPerSample/8
  view.setUint16(34, 16, true); // BitsPerSample: 16

  // data chunk
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return arrayBufferToBase64(buffer);
}

export class VadAudioCapture {
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private muteGainNode: GainNode | null = null;
  private workletUrl: string | null = null;
  private callbacks: VadCaptureCallbacks;

  private isRunning = false;
  private currentVadStatus: VadStatus = 'idle';
  private sessionStartMs = 0;

  // VAD & buffering state at 16kHz
  private preSpeechRing: Float32Array = new Float32Array(0);
  private activeChunks: Float32Array[] = [];
  private activeSampleCount = 0;
  private speechStartElapsedSec = 0;
  private trailingSilenceSamples = 0;
  private noiseFloor = 0.008;
  private lastLevelEmitMs = 0;

  constructor(callbacks: VadCaptureCallbacks) {
    this.callbacks = callbacks;
  }

  public async start(stream: MediaStream): Promise<void> {
    this.stop();

    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.audioContext = ctx;
    this.isRunning = true;
    this.sessionStartMs = Date.now();
    this.preSpeechRing = new Float32Array(0);
    this.activeChunks = [];
    this.activeSampleCount = 0;
    this.trailingSilenceSamples = 0;
    this.noiseFloor = 0.008;

    const source = ctx.createMediaStreamSource(stream);
    this.sourceNode = source;

    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;
    muteGain.connect(ctx.destination);
    this.muteGainNode = muteGain;

    const inputRate = ctx.sampleRate;

    let workletAttached = false;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
        this.workletUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(this.workletUrl);
        const worklet = new AudioWorkletNode(ctx, 'vad-pcm-processor');
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (!this.isRunning) return;
          this.processAudioFrame(event.data, inputRate);
        };
        source.connect(worklet);
        worklet.connect(muteGain);
        this.workletNode = worklet;
        workletAttached = true;
      } catch {
        workletAttached = false;
      }
    }

    if (!workletAttached) {
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!this.isRunning) return;
        const channelData = event.inputBuffer.getChannelData(0);
        this.processAudioFrame(new Float32Array(channelData), inputRate);
      };
      source.connect(processor);
      processor.connect(muteGain);
      this.scriptNode = processor;
    }

    this.setVadStatus('monitoring');
  }

  public stop(): void {
    // Flush any pending speech segment before tearing down
    if (this.isRunning && this.currentVadStatus === 'speech' && this.activeSampleCount > 0) {
      this.flushSpeechSegment();
    }

    this.isRunning = false;

    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }

    if (this.scriptNode) {
      try {
        this.scriptNode.onaudioprocess = null;
        this.scriptNode.disconnect();
      } catch {}
      this.scriptNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
      this.sourceNode = null;
    }

    if (this.muteGainNode) {
      try {
        this.muteGainNode.disconnect();
      } catch {}
      this.muteGainNode = null;
    }

    if (this.workletUrl) {
      try {
        URL.revokeObjectURL(this.workletUrl);
      } catch {}
      this.workletUrl = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;

    this.preSpeechRing = new Float32Array(0);
    this.activeChunks = [];
    this.activeSampleCount = 0;
    this.trailingSilenceSamples = 0;
    this.setVadStatus('idle');
    this.callbacks.onAudioLevel(0);
  }

  private setVadStatus(status: VadStatus): void {
    if (this.currentVadStatus !== status) {
      this.currentVadStatus = status;
      this.callbacks.onVadStatusChange(status);
    }
  }

  private processAudioFrame(rawFrame: Float32Array, inputSampleRate: number): void {
    const samples16k = downsampleTo16k(rawFrame, inputSampleRate);
    if (samples16k.length === 0) return;

    // Compute RMS energy
    let sumSq = 0;
    for (let i = 0; i < samples16k.length; i++) {
      const s = samples16k[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples16k.length);

    const now = Date.now();
    if (now - this.lastLevelEmitMs >= 80) {
      this.lastLevelEmitMs = now;
      this.callbacks.onAudioLevel(Math.min(1, rms * 6));
    }

    const speechThreshold = Math.max(0.013, Math.min(0.06, this.noiseFloor * 2.6));
    const isVoiceFrame = rms >= speechThreshold;

    const preSpeechMaxSamples = Math.floor((PRE_SPEECH_MS / 1000) * TARGET_SAMPLE_RATE);
    const hangoverMaxSamples = Math.floor((HANGOVER_MS / 1000) * TARGET_SAMPLE_RATE);
    const maxSegmentSamples = Math.floor((MAX_SEGMENT_MS / 1000) * TARGET_SAMPLE_RATE);

    if (this.currentVadStatus !== 'speech') {
      if (isVoiceFrame) {
        // Transition from monitoring -> speech; prepend pre-speech ring buffer so onset isn't clipped
        this.speechStartElapsedSec = Math.max(0, (now - this.sessionStartMs - PRE_SPEECH_MS) / 1000);
        this.activeChunks = [];
        this.activeSampleCount = 0;
        if (this.preSpeechRing.length > 0) {
          this.activeChunks.push(this.preSpeechRing);
          this.activeSampleCount += this.preSpeechRing.length;
          this.preSpeechRing = new Float32Array(0);
        }
        this.activeChunks.push(samples16k);
        this.activeSampleCount += samples16k.length;
        this.trailingSilenceSamples = 0;
        this.setVadStatus('speech');
      } else {
        // Update adaptive background noise floor gently while silent
        this.noiseFloor = this.noiseFloor * 0.96 + rms * 0.04;
        // Maintain rolling pre-speech buffer
        const combined = new Float32Array(this.preSpeechRing.length + samples16k.length);
        combined.set(this.preSpeechRing, 0);
        combined.set(samples16k, this.preSpeechRing.length);
        if (combined.length > preSpeechMaxSamples) {
          this.preSpeechRing = combined.slice(combined.length - preSpeechMaxSamples);
        } else {
          this.preSpeechRing = combined;
        }
      }
      return;
    }

    // Currently in 'speech' state
    this.activeChunks.push(samples16k);
    this.activeSampleCount += samples16k.length;

    if (isVoiceFrame) {
      this.trailingSilenceSamples = 0;
    } else {
      this.trailingSilenceSamples += samples16k.length;
    }

    if (this.trailingSilenceSamples >= hangoverMaxSamples || this.activeSampleCount >= maxSegmentSamples) {
      this.flushSpeechSegment();
      this.setVadStatus('monitoring');
    }
  }

  private flushSpeechSegment(): void {
    const minSamples = Math.floor((MIN_SPEECH_MS / 1000) * TARGET_SAMPLE_RATE);
    // Exclude excess trailing silence beyond 200ms padding
    const keepPaddingSamples = Math.floor(0.2 * TARGET_SAMPLE_RATE);
    const trimSamples = Math.max(0, this.trailingSilenceSamples - keepPaddingSamples);
    const usableSamples = this.activeSampleCount - trimSamples;

    if (usableSamples < minSamples) {
      this.activeChunks = [];
      this.activeSampleCount = 0;
      this.trailingSilenceSamples = 0;
      return;
    }

    const merged = new Float32Array(usableSamples);
    let offset = 0;
    for (const chunk of this.activeChunks) {
      if (offset >= usableSamples) break;
      const take = Math.min(chunk.length, usableSamples - offset);
      merged.set(chunk.subarray(0, take), offset);
      offset += take;
    }

    this.activeChunks = [];
    this.activeSampleCount = 0;
    this.trailingSilenceSamples = 0;

    const tailSamplesCount = Math.min(merged.length, Math.floor((OVERLAP_TAIL_MS / 1000) * TARGET_SAMPLE_RATE));
    const tailSlice = merged.slice(merged.length - tailSamplesCount);

    const audioBase64 = encodeWav16kMonoBase64(merged);
    const tailAudioBase64 = encodeWav16kMonoBase64(tailSlice);
    const durationMs = Math.round((merged.length / TARGET_SAMPLE_RATE) * 1000);

    this.callbacks.onSpeechSegment({
      audioBase64,
      tailAudioBase64,
      durationMs,
      elapsedSeconds: this.speechStartElapsedSec,
    });
  }
}
