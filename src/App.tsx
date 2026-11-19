import React, { useState, useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { LocationConfidenceMap } from './LocationConfidenceMap';
import { VadAudioCapture, VadStatus, VadSegmentPayload } from './utils/vadAudioCapture';
import {
  Play,
  Pause,
  Trash2,
  Plus,
  Shield,
  AlertTriangle,
  Phone,
  Clock,
  FileText,
  Activity,
  Server,
  Volume2,
  MapPin,
  MessageSquare,
  Mic,
  PlaySquare,
  Square,
  CheckCircle,
  XCircle,
  ChevronDown,
  Info,
  Download,
  Globe,
  RefreshCw,
} from 'lucide-react';

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: 'var(--critical)',
  HIGH: 'var(--high)',
  PENDING: 'var(--pending)',
  RESOLVED: 'var(--resolved)',
};

export interface SpeakerVoiceProfile {
  pitch: string;
  timbre: string;
  micDistance: string;
  speakingCadence: string;
  summary: string;
}

export type Case = {
  id: string;
  priority: string;
  type: string;
  location: string;
  phone: string;
  lang: string;
  time: string;
  status: 'IN PROGRESS' | 'RESOLVED';
  turns: any[];
  analysis: any;
  metaData: any;
  auditLog?: any[];
  fileHash?: string;
  duration?: string;
  audioUrl?: string;
};

const isLegacyDeepgramMessage = (text: unknown): boolean =>
  typeof text === 'string' && text.toLowerCase().includes('live transcription requires deepgram api key');

// --- COMPONENTS ---

const AudioWaveform = ({ url }: { url: string }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#2E4457',
      progressColor: '#4FB8B0',
      cursorColor: '#E4572E',
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      height: 48,
      normalize: true,
    });

    wavesurfer.load(url).catch((e) => {
      if (e.name !== 'AbortError' && !e.message?.includes('aborted')) {
        console.error('WaveSurfer load error:', e);
      }
    });

    wavesurfer.on('play', () => setIsPlaying(true));
    wavesurfer.on('pause', () => setIsPlaying(false));

    wavesurferRef.current = wavesurfer;

    return () => {
      wavesurfer.destroy();
    };
  }, [url]);

  const togglePlay = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.playPause();
    }
  };

  return (
    <div className="flex items-center gap-3 bg-[var(--bg-panel)] border border-[var(--border)] p-2">
      <button
        onClick={togglePlay}
        className="w-8 h-8 flex items-center justify-center bg-[var(--info-tag)] text-black hover:bg-white transition-colors shrink-0"
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>
      <div ref={containerRef} className="flex-1 min-w-0" />
    </div>
  );
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'QUEUE' | 'ACTIVE' | 'AUDIT'>('QUEUE');
  const [cases, setCases] = useState<Case[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());

  // Purge any leftover Deepgram messages or keys from localStorage on startup
  useEffect(() => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key) continue;
        const val = localStorage.getItem(key) || '';
        if (val.toLowerCase().includes('deepgram') || key.toLowerCase().includes('deepgram')) {
          localStorage.removeItem(key);
        }
      }
    } catch {}
  }, []);

  const selectedCase = cases.find((c) => c.id === selectedCaseId) || null;

  const createNewCase = () => {
    const newId = `NHAA-${Math.floor(1000 + Math.random() * 9000)}`;
    const newCase: Case = {
      id: newId,
      priority: 'PENDING',
      type: 'NEW CALL',
      location: '',
      phone: '',
      lang: 'Auto-detect',
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      status: 'IN PROGRESS',
      turns: [],
      analysis: {},
      metaData: null,
    };
    setCases((prev) => [newCase, ...prev]);
    setSelectedCaseId(newId);
    setActiveTab('ACTIVE');
  };

  const updateCase = (id: string, updates: Partial<Case>) => {
    const sanitizedUpdates = updates.turns
      ? {
          ...updates,
          turns: updates.turns.filter(
            (t: any) => !isLegacyDeepgramMessage(t?.text) && !isLegacyDeepgramMessage(t?.originalText)
          ),
        }
      : updates;
    setCases((prev) => prev.map((c) => (c.id === id ? { ...c, ...sanitizedUpdates } : c)));
  };

  const updateCaseId = (oldId: string, newId: string) => {
    if (!newId || newId === oldId) return;
    setCases((prev) => prev.map((c) => (c.id === oldId ? { ...c, id: newId } : c)));
    if (selectedCaseId === oldId) {
      setSelectedCaseId(newId);
    }
  };

  const deleteCase = (id: string) => {
    setCases((prev) => prev.filter((c) => c.id !== id));
    if (selectedCaseId === id) {
      setSelectedCaseId(null);
      setActiveTab('QUEUE');
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-main)] text-[var(--text-primary)] select-none">
      {/* TOP NAVIGATION BAR */}
      <header className="flex items-center justify-between px-4 py-2 bg-[var(--bg-panel)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2.5 w-1/3">
          <Shield className="w-5 h-5 text-[var(--info-tag)]" />
          <span className="font-bold tracking-wider text-sm uppercase">NHAA 14566</span>
        </div>

        <div className="flex justify-center w-1/3 space-x-1">
          {(['QUEUE', 'ACTIVE', 'AUDIT'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              disabled={tab !== 'QUEUE' && !selectedCaseId}
              className={`px-6 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors border ${
                activeTab === tab
                  ? 'bg-[var(--bg-main)] border-[var(--border)] text-[var(--text-primary)]'
                  : tab !== 'QUEUE' && !selectedCaseId
                  ? 'bg-transparent border-transparent text-[var(--text-secondary)] opacity-50 cursor-not-allowed'
                  : 'bg-transparent border-transparent text-[var(--text-secondary)] hover:bg-[var(--border)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tab === 'QUEUE' ? 'Case Queue' : tab === 'ACTIVE' ? 'Active Call' : 'Evidence / Audit'}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-6 w-1/3 text-xs text-[var(--text-secondary)]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--resolved)]"></span>
            <span>SECURE SESSION: OPR-442</span>
          </div>
          <div className="flex items-center gap-2 font-mono">
            <Clock className="w-3.5 h-3.5" />
            {currentTime.toLocaleTimeString('en-US', { hour12: false })}
          </div>
        </div>
      </header>

      {/* MAIN WORKSPACE */}
      <main className="flex-1 overflow-hidden p-2 min-h-0">
        {activeTab === 'QUEUE' && (
          <CaseQueueView
            cases={cases}
            selectedCaseId={selectedCaseId}
            setSelectedCaseId={setSelectedCaseId}
            createNewCase={createNewCase}
            deleteCase={deleteCase}
            setActiveTab={setActiveTab}
          />
        )}
        {activeTab === 'ACTIVE' && (
          <ActiveCallView
            currentCase={selectedCase}
            updateCase={updateCase}
            updateCaseId={updateCaseId}
            createNewCase={createNewCase}
          />
        )}
        {activeTab === 'AUDIT' && <EvidenceAuditView currentCase={selectedCase} updateCase={updateCase} />}
      </main>

      {/* BOTTOM STATUS STRIP */}
      <footer className="flex items-center justify-between px-3 py-1 bg-[var(--bg-panel)] border-t border-[var(--border)] shrink-0 text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" />
            <span>Sys: ONLINE • Gemini Native Audio</span>
          </div>
        </div>
        <div className="italic text-[var(--info-tag)]">
          "AI suggestions support — not replace — operator judgment."
        </div>
      </footer>
    </div>
  );
}

// --- TYPES & HELPERS ---
type TranscriptLine = {
  id: number | string;
  speaker: string;
  speakerId?: string | null;
  timestamp: string;
  start?: number;
  end?: number;
  text: string;
  originalText?: string;
  englishText?: string;
  detectedLanguage?: string;
  confidence?: number;
  roleCorrected?: boolean;
  isFinal?: boolean;
  isNote?: boolean;
  fullNote?: string;
};

const formatTimestamp = (val: number | string): string => {
  if (val == null) return '00:00';
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return String(val);
  const totalSeconds = num > 10000 ? Math.floor(num / 1000) : Math.floor(num);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

const normalizeTranscript = (data: any): TranscriptLine[] => {
  const list = Array.isArray(data.turns)
    ? data.turns
    : Array.isArray(data.transcript)
    ? data.transcript
    : Array.isArray(data.utterances)
    ? data.utterances
    : [];

  return list
    .filter((t: any) => !isLegacyDeepgramMessage(t?.text) && !isLegacyDeepgramMessage(t?.originalText))
    .map((t: any, i: number) => {
      const orig = t.originalText || t.text || '';
      const eng = t.englishText || orig;
      return {
        id: t.id || i,
        speaker: t.speaker || t.role || t.speaker_id || 'Unknown',
        speakerId: t.speaker_id || null,
        timestamp: t.timestamp || formatTimestamp(t.start || t.start_seconds || 0),
        start: t.start || 0,
        end: t.end || 0,
        text: orig,
        originalText: orig,
        englishText: eng,
        detectedLanguage: t.detectedLanguage || data.language || undefined,
        confidence: typeof t.confidence === 'number' ? t.confidence : undefined,
        isFinal: t.isFinal !== false,
      };
    });
};

// --- VIEWS ---

function CaseQueueView({
  cases,
  selectedCaseId,
  setSelectedCaseId,
  createNewCase,
  deleteCase,
  setActiveTab,
}: {
  cases: Case[];
  selectedCaseId: string | null;
  setSelectedCaseId: (id: string) => void;
  createNewCase: () => void;
  deleteCase: (id: string) => void;
  setActiveTab: (t: 'QUEUE' | 'ACTIVE' | 'AUDIT') => void;
}) {
  if (cases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)] gap-6">
        <div className="text-center space-y-2">
          <p className="text-sm font-mono">No active or past cases in queue.</p>
          <p className="text-xs opacity-70">Click the circular + button below to start a session.</p>
        </div>
        <button
          onClick={createNewCase}
          className="w-12 h-12 rounded-full bg-[var(--info-tag)] text-black flex items-center justify-center hover:bg-white transition-colors shadow-lg shadow-black/50 hover:scale-105 active:scale-95 duration-200"
          title="Start New Case"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto h-full overflow-y-auto space-y-2 py-2">
      {cases.map((c) => (
        <div
          key={c.id}
          onClick={() => {
            setSelectedCaseId(c.id);
            setActiveTab('ACTIVE');
          }}
          className={`flex text-left w-full bg-[var(--bg-panel)] border border-[var(--border)] transition-colors hover:bg-[var(--border)] focus:outline-none cursor-pointer ${
            selectedCaseId === c.id ? 'ring-1 ring-[var(--info-tag)] bg-[var(--border)]' : ''
          }`}
          style={{ borderLeft: `6px solid ${PRIORITY_COLORS[c.priority]}` }} > <div className="flex-1 p-3"> <div className="flex items-center justify-between"> <div className="flex items-center gap-3"> <span className="font-mono font-bold text-sm text-[var(--text-primary)]">{c.id}</span> <span className="text-xs font-bold px-2 py-0.5 bg-[var(--bg-main)] border border-[var(--border)]" style={{ color: PRIORITY_COLORS[c.priority] }} > {c.priority} </span> <span className="text-xs font-semibold uppercase text-[var(--text-secondary)]">{c.type}</span> </div> <span className="font-mono text-xs text-[var(--text-secondary)]">{c.time}</span> </div>  <div className="flex items-center gap-6 mt-1 text-xs text-[var(--text-secondary)]"> <div className="flex items-center gap-1.5"> <MapPin className="w-3.5 h-3.5" /> {c.location \vert{}\vert{} 'Location pending'} </div> <div className="flex items-center gap-1.5"> <Phone className="w-3.5 h-3.5" /> {c.phone \vert{}\vert{} 'Unknown number'} </div> <div className="flex items-center gap-1.5"> <MessageSquare className="w-3.5 h-3.5" /> {c.lang} </div> </div> </div> <div className="flex items-center px-3" onClick={(e) => { e.stopPropagation(); deleteCase(c.id); }} > <button className="text-[var(--text-secondary)] hover:text-[var(--critical)] p-2 transition-colors"> <Trash2 className="w-4 h-4" /> </button> </div> </div> ))} <div className="flex justify-center mt-4 pb-8"> <button onClick={createNewCase} className="w-12 h-12 rounded-full bg-[var(--info-tag)] text-black flex items-center justify-center hover:bg-white transition-colors shadow-lg shadow-black/50 hover:scale-105 active:scale-95 duration-200" > <Plus className="w-6 h-6" /> </button> </div> </div> ); }  function ActiveCallView({ currentCase, updateCase, updateCaseId, createNewCase, }: { currentCase: any; updateCase: (id: string, updates: any) => void; updateCaseId: (oldId: string, newId: string) => void; createNewCase: () => void; }) { const [isRunning, setIsRunning] = useState(false); const [vadStatus, setVadStatus] = useState<VadStatus>('idle'); const [audioLevel, setAudioLevel] = useState(0); const [isProcessingSegment, setIsProcessingSegment] = useState(false);  const [phoneNumber, setPhoneNumber] = useState(''); const [backendUrl, setBackendUrl] = useState(() => window.location.origin);  useEffect(() => { try { localStorage.setItem('backendUrl', backendUrl); } catch {} }, [backendUrl]);  const [isConnected, setIsConnected] = useState<boolean \vert{} null>(null); const [rawError, setRawError] = useState<string \vert{} null>(null); const [analysisUnavailable, setAnalysisUnavailable] = useState(false); const [sourceLanguage, setSourceLanguage] = useState('auto'); const [showEnglishTranslation, setShowEnglishTranslation] = useState(false);  const [operatorNote, setOperatorNote] = useState(''); const [showSviDetails, setShowSviDetails] = useState(false); const [toastMessage, setToastMessage] = useState<string \vert{} null>(null); const [clickedActions, setClickedActions] = useState<Record<string, boolean>>({}); const [isTranslating, setIsTranslating] = useState(false);  // Acoustic Speaker Diarization State (profiles + cached reference audio clips + rolling tail) const [operatorVoiceProfile, setOperatorVoiceProfile] = useState<SpeakerVoiceProfile \vert{} null>(null); const [callerVoiceProfile, setCallerVoiceProfile] = useState<SpeakerVoiceProfile \vert{} null>(null); const operatorProfileRef = useRef<SpeakerVoiceProfile \vert{} null>(null); const callerProfileRef = useRef<SpeakerVoiceProfile \vert{} null>(null); const operatorRefAudioRef = useRef<string \vert{} null>(null); const callerRefAudioRef = useRef<string \vert{} null>(null); const previousTailAudioRef = useRef<string \vert{} null>(null); const turnsRef = useRef<TranscriptLine[]>([]); const analysisRef = useRef<any>({}); const segmentQueueRef = useRef<VadSegmentPayload[]>([]); const queueBusyRef = useRef(false);  const LANGUAGES = [ { code: 'auto', label: 'Auto-detect' }, { code: 'hi', label: 'Hindi' }, { code: 'bn', label: 'Bengali' }, { code: 'mr', label: 'Marathi' }, { code: 'ta', label: 'Tamil' }, { code: 'te', label: 'Telugu' }, { code: 'pa', label: 'Punjabi' }, { code: 'ur', label: 'Urdu' }, { code: 'gu', label: 'Gujarati' }, { code: 'kn', label: 'Kannada' }, { code: 'ml', label: 'Malayalam' }, { code: 'as', label: 'Assamese' }, { code: 'ne', label: 'Nepali' }, { code: 'sd', label: 'Sindhi' }, { code: 'en', label: 'English' }, ];  // Audio state const [turns, setTurns] = useState<TranscriptLine[]>([]); const [uploadState, setUploadState] = useState<'idle' \vert{} 'uploading' \vert{} 'processing' \vert{} 'success' \vert{} 'error'>('idle'); const [metaData, setMetaData] = useState<any>(null);  const fileInputRef = useRef<HTMLInputElement \vert{} null>(null);  const [analysis, setAnalysis] = useState<any>({ riskScore: 0, signals: [], emotionalFactors: [], sentiment: 'Neutral', recommendedActions: [], suggestedQuestions: [], callerStatus: 'Unknown', locationStatus: 'Unknown', extractedLocation: null, detectedLanguage: null, translations: {}, correctedOriginals: {}, });  useEffect(() => { turnsRef.current = turns; }, [turns]);  useEffect(() => { analysisRef.current = analysis; }, [analysis]);  useEffect(() => { operatorProfileRef.current = operatorVoiceProfile; }, [operatorVoiceProfile]);  useEffect(() => { callerProfileRef.current = callerVoiceProfile; }, [callerVoiceProfile]);  // Sync state from selected case when it changes useEffect(() => { if (currentCase) { const cleanedTurns = (currentCase.turns \vert{}\vert{} []).filter( (t: any) => !isLegacyDeepgramMessage(t?.text) && !isLegacyDeepgramMessage(t?.originalText) ); setTurns(cleanedTurns); setAnalysis( currentCase.analysis && Object.keys(currentCase.analysis).length > 0 ? currentCase.analysis : { riskScore: 0, signals: [], emotionalFactors: [], sentiment: 'Neutral', recommendedActions: [], suggestedQuestions: [], callerStatus: 'Unknown', locationStatus: 'Unknown', extractedLocation: null, detectedLanguage: null, translations: {}, correctedOriginals: {}, } ); setMetaData(currentCase.metaData \vert{}\vert{} null); setPhoneNumber(currentCase.phone \vert{}\vert{} ''); // Reset per-call acoustic references on case switch setOperatorVoiceProfile(null); setCallerVoiceProfile(null); operatorRefAudioRef.current = null; callerRefAudioRef.current = null; previousTailAudioRef.current = null; segmentQueueRef.current = []; } else { setTurns([]); setAnalysis({ riskScore: 0, signals: [], emotionalFactors: [], sentiment: 'Neutral', recommendedActions: [], suggestedQuestions: [], callerStatus: 'Unknown', locationStatus: 'Unknown', extractedLocation: null, detectedLanguage: null, translations: {}, correctedOriginals: {}, }); setMetaData(null); setPhoneNumber(''); } }, [currentCase?.id]);  // Sync back to currentCase when local state changes useEffect(() => { if (currentCase) { const score = analysis.riskScore \vert{}\vert{} 0; const computedPriority = currentCase.status === 'RESOLVED' ? 'RESOLVED' : score >= 85 ? 'CRITICAL' : score >= 50 ? 'HIGH' : currentCase.priority \vert{}\vert{} 'PENDING';  updateCase(currentCase.id, { turns, analysis, metaData, phone: phoneNumber, priority: computedPriority, ...(analysis.detectedLanguage && { lang: analysis.detectedLanguage }), ...(analysis.extractedLocation && { location: analysis.extractedLocation }), ...(analysis.caseTitle && { type: analysis.caseTitle.toUpperCase() }), }); } }, [turns, analysis, metaData, phoneNumber]);  const transcriptContainerRef = useRef<HTMLDivElement \vert{} null>(null); const isUserScrolledUpRef = useRef(false); const isRunningRef = useRef(false); const streamRef = useRef<MediaStream \vert{} null>(null); const vadCaptureRef = useRef<VadAudioCapture \vert{} null>(null); const mediaRecorderRef = useRef<MediaRecorder \vert{} null>(null); const audioChunksRef = useRef<Blob[]>([]); const [micError, setMicError] = useState<string \vert{} null>(null);  // Cleanup mic/VAD on unmount useEffect(() => { return () => { stopListening(); }; }, []);  // Health check polling useEffect(() => { const checkHealth = async () => { try { const base = backendUrl.trim() \vert{}\vert{} window.location.origin; const res = await fetch(`${base}/health`, {
          headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        if (res.ok) {
          setIsConnected(true);
          setRawError(null);
        } else {
          setIsConnected(false);
          setRawError(`Health check failed: ${res.status} ${res.statusText}`); } } catch (err: any) { setIsConnected(false); setRawError(err.message \vert{}\vert{} 'Health check failed to fetch'); } };  checkHealth(); const interval = setInterval(checkHealth, 8000); return () => clearInterval(interval); }, [backendUrl]);  const handleTranscriptScroll = (e: React.UIEvent<HTMLDivElement>) => { const target = e.currentTarget; const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 60; isUserScrolledUpRef.current = !isNearBottom; };  useEffect(() => { if (isRunning && !isUserScrolledUpRef.current && transcriptContainerRef.current) { transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight; } }, [turns, isRunning]);  const handleTranslateToggle = async () => { if (turns.length === 0) return; const nextShowEnglish = !showEnglishTranslation; setShowEnglishTranslation(nextShowEnglish);  if (nextShowEnglish) { // Check if any non-note turns are missing English translations const needsBackendTranslate = turns.some( (t, idx) => !t.isNote && !t.englishText && !(analysis?.translations && analysis.translations[idx.toString()]) ); if (needsBackendTranslate) { setIsTranslating(true); try { const base = backendUrl.trim() \vert{}\vert{} window.location.origin; const res = await fetch(`${base}/api/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ turns }),
          });
          const data = await res.json();
          if (data && data.translations) {
            setTurns((prev) =>
              prev.map((t, idx) => ({
                ...t,
                englishText: data.translations[idx.toString()] || t.englishText || t.text,
              }))
            );
            setAnalysis((prev: any) => ({
              ...prev,
              translations: { ...(prev?.translations || {}), ...data.translations },
            }));
          }
        } catch (e) {
          console.error('Translation failed', e);
        } finally {
          setIsTranslating(false);
        }
      }
    }
  };

  const handleRecommendedAction = (action: string) => {
    setClickedActions((prev) => ({ ...prev, [action]: true }));
    setToastMessage(`Action Taken: ${action}`);
    setTimeout(() => setToastMessage(null), 3000);

    if (currentCase) {
      const newLog = {
        time: new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        type: 'alert',
        actor: 'OP-01',
        message: `Recommended Action Taken: ${action}`, }; updateCase(currentCase.id, { auditLog: [...(currentCase.auditLog \vert{}\vert{} []), newLog], }); } };  const handleOperatorNoteSubmit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!operatorNote.trim() \vert{}\vert{} !currentCase) return;  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', });  const newLog = { time: timeStr, type: 'operator', actor: 'OP-01', message: `Note: ${operatorNote.trim()}`,
      };

      const newTurn: TranscriptLine = {
        id: Date.now() + Math.random(),
        speaker: 'SYSTEM',
        start: 0,
        end: 0,
        timestamp: timeStr,
        text: `*Operator note: ${operatorNote.trim()}*`,
        originalText: `*Operator note: ${operatorNote.trim()}*`,
        englishText: `*Operator note: ${operatorNote.trim()}*`, isFinal: true, isNote: true, fullNote: operatorNote.trim(), };  updateCase(currentCase.id, { auditLog: [...(currentCase.auditLog \vert{}\vert{} []), newLog], turns: [...(currentCase.turns \vert{}\vert{} []), newTurn], });  setTurns((prev) => [...prev, newTurn]); setOperatorNote(''); } };  const toggleIngestion = () => { if (isRunning) { stopListening(); } else { startListening(); } };  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return;  setUploadState('uploading'); setRawError(null); setTurns([]); setMetaData(null);  try { const formData = new FormData(); formData.append('file', file); formData.append('language', sourceLanguage);  const base = backendUrl.trim() \vert{}\vert{} window.location.origin; const cleanUrl = base.replace(/\/$/, ''); const uploadUrl = `${cleanUrl}/api/transcribe_file`;

      setUploadState('processing');

      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
        headers: { 'ngrok-skip-browser-warning': 'true' },
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Upload failed with status ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }

      const localAudioUrl = URL.createObjectURL(file);
      updateCase(currentCase.id, { audioUrl: localAudioUrl });
      const normalizedTurns = normalizeTranscript(data);
      if (normalizedTurns.length > 0) {
        setTurns(normalizedTurns);
        setMetaData({
          sha256: data.sha256 || null,
          language: data.language || null,
          speakerCount: data.speaker_count_detected || null,
        });
        setUploadState('success');
        analyzeTranscript(normalizedTurns);
        isUserScrolledUpRef.current = true;
        setTimeout(() => {
          if (transcriptContainerRef.current) {
            transcriptContainerRef.current.scrollTop = 0;
          }
        }, 50);
      } else {
        throw new Error('No speech detected in uploaded audio file.');
      }
    } catch (err: any) {
      setRawError(`File Upload Error: ${err.message}`); setUploadState('error'); } finally { if (fileInputRef.current) fileInputRef.current.value = ''; } };  // Sequential queue processor so each VAD segment uses the latest updated acoustic voice profiles const drainSegmentQueue = async () => { if (queueBusyRef.current) return; queueBusyRef.current = true; setIsProcessingSegment(true);  try { while (segmentQueueRef.current.length > 0) { const segment = segmentQueueRef.current.shift()!; await processSingleVadSegment(segment); } } finally { queueBusyRef.current = false; setIsProcessingSegment(false); } };  const processSingleVadSegment = async (segment: VadSegmentPayload) => { try { const base = backendUrl.trim() \vert{}\vert{} window.location.origin; const cleanUrl = base.replace(/\/$/, '');  const recentTurnsPayload = turnsRef.current .filter((t) => !t.isNote) .slice(-8) .map((t, idx, arr) => { const allNonNote = turnsRef.current.filter((item) => !item.isNote); const actualTurnIndex = allNonNote.length - arr.length + idx; return { turnIndex: actualTurnIndex, speaker: t.speaker, timestamp: t.timestamp, originalText: t.originalText \vert{}\vert{} t.text, englishText: t.englishText \vert{}\vert{} t.text, }; });  const response = await fetch(`${cleanUrl}/api/live-segment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({
          audioBase64: segment.audioBase64,
          mimeType: 'audio/wav',
          elapsedSeconds: segment.elapsedSeconds,
          sourceLanguageHint: sourceLanguage,
          operatorVoiceProfile: operatorProfileRef.current,
          callerVoiceProfile: callerProfileRef.current,
          operatorRefAudioBase64: operatorRefAudioRef.current,
          callerRefAudioBase64: callerRefAudioRef.current,
          previousTailAudioBase64: previousTailAudioRef.current,
          recentTurns: recentTurnsPayload,
          currentAnalysis: analysisRef.current,
        }),
      });

      // Always update rolling tail overlap for acoustic continuity into the next segment
      previousTailAudioRef.current = segment.tailAudioBase64;

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Live transcription HTTP ${response.status}`);
      }

      const data = await response.json();
      setRawError(null);
      setAnalysisUnavailable(false);

      // Update stored acoustic voice profiles
      if (data.operatorVoiceProfile) {
        setOperatorVoiceProfile(data.operatorVoiceProfile);
        operatorProfileRef.current = data.operatorVoiceProfile;
      }
      if (data.callerVoiceProfile) {
        setCallerVoiceProfile(data.callerVoiceProfile);
        callerProfileRef.current = data.callerVoiceProfile;
      }

      // Apply retroactive role correction if Gemini detected an ambiguous opening turn
      if (data.retroactiveRoleFix && typeof data.retroactiveRoleFix.turnIndex === 'number') {
        const { turnIndex, correctedSpeaker, reason } = data.retroactiveRoleFix;
        setTurns((prev) => {
          let nonNoteCounter = 0;
          return prev.map((t) => {
            if (t.isNote) return t;
            const currentIdx = nonNoteCounter++;
            if (currentIdx === turnIndex && t.speaker !== correctedSpeaker) {
              return { ...t, speaker: correctedSpeaker, roleCorrected: true };
            }
            return t;
          });
        });

        // If turn 0 was retroactively corrected, swap cached reference clip to match true role
        if (turnIndex === 0) {
          if (correctedSpeaker === 'Caller' && operatorRefAudioRef.current && !callerRefAudioRef.current) {
            callerRefAudioRef.current = operatorRefAudioRef.current;
            operatorRefAudioRef.current = null;
          } else if (correctedSpeaker === 'Operator' && callerRefAudioRef.current && !operatorRefAudioRef.current) {
            operatorRefAudioRef.current = callerRefAudioRef.current;
            callerRefAudioRef.current = null;
          }
        }

        if (currentCase) {
          updateCase(currentCase.id, {
            auditLog: [
              ...(currentCase.auditLog || []),
              {
                time: new Date().toLocaleTimeString('en-US', { hour12: false }),
                type: 'ai',
                actor: 'DIARIZE_AI',
                message: `Auto-corrected Turn #${turnIndex + 1} to ${correctedSpeaker}:${reason}`,
              },
            ],
          });
        }
      }

      // Append new diarized segments and cache first high-confidence reference audio per speaker
      if (Array.isArray(data.segments) && data.segments.length > 0) {
        const newLines: TranscriptLine[] = data.segments.map((seg: any, idx: number) => {
          const speakerLabel = seg.speaker === 'Operator' ? 'Operator' : 'Caller';
          if (speakerLabel === 'Operator' && !operatorRefAudioRef.current && (seg.confidence ?? 0.9) >= 0.75) {
            operatorRefAudioRef.current = segment.audioBase64;
          } else if (speakerLabel === 'Caller' && !callerRefAudioRef.current && (seg.confidence ?? 0.9) >= 0.75) {
            callerRefAudioRef.current = segment.audioBase64;
          }

          return {
            id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`, speaker: speakerLabel, timestamp: seg.timestamp \vert{}\vert{} formatTimestamp(segment.elapsedSeconds), start: segment.elapsedSeconds, end: segment.elapsedSeconds + segment.durationMs / 1000, text: seg.originalText, originalText: seg.originalText, englishText: seg.englishText \vert{}\vert{} seg.originalText, detectedLanguage: seg.detectedLanguage \vert{}\vert{} data.sourceLanguage, confidence: seg.confidence, isFinal: true, }; });  setTurns((prev) => { const updated = [...prev, ...newLines]; const translationMap: Record<string, string> = {}; updated.forEach((line, i) => { if (line.englishText) { translationMap[i.toString()] = line.englishText; } }); setAnalysis((prevAnalysis: any) => ({ ...prevAnalysis, translations: { ...(prevAnalysis?.translations \vert{}\vert{} {}), ...translationMap }, })); return updated; });  setMetaData((prevMeta: any) => ({ ...(prevMeta \vert{}\vert{} {}), language: data.sourceLanguage \vert{}\vert{} prevMeta?.language \vert{}\vert{} null, speakerCount: (operatorProfileRef.current ? 1 : 0) + (callerProfileRef.current ? 1 : 0) \vert{}\vert{} prevMeta?.speakerCount \vert{}\vert{} null, })); }  // Update unified emergency intelligence in the same response const geo = data.geolocation \vert{}\vert{} {}; setAnalysis((prev: any) => ({ ...prev, caseTitle: data.caseTitle \vert{}\vert{} prev.caseTitle, riskScore: typeof data.stressVulnerabilityIndex === 'number' ? data.stressVulnerabilityIndex : prev.riskScore, signals: Array.isArray(data.detectedRiskSignals) ? data.detectedRiskSignals : prev.signals, emotionalFactors: Array.isArray(data.sviRationale) && data.sviRationale.length > 0 ? data.sviRationale : prev.emotionalFactors, sentiment: data.sentiment \vert{}\vert{} prev.sentiment, recommendedActions: Array.isArray(data.recommendedActions) ? data.recommendedActions : prev.recommendedActions, suggestedQuestions: Array.isArray(data.suggestedQuestions) ? data.suggestedQuestions : prev.suggestedQuestions, callerStatus: data.callerStatus \vert{}\vert{} prev.callerStatus, detectedLanguage: data.sourceLanguage \vert{}\vert{} prev.detectedLanguage, extractedLocation: geo.extractedLocation ?? prev.extractedLocation, locationStatus: geo.locationStatus \vert{}\vert{} prev.locationStatus, location_estimate: geo.location_estimate \vert{}\vert{} prev.location_estimate, })); } catch (err: any) { console.error('Live segment pipeline error:', err?.message \vert{}\vert{} err); setRawError(err?.message \vert{}\vert{} 'Live audio transcription failed'); setAnalysisUnavailable(true); } };  const startListening = async () => { try { const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, }, }); streamRef.current = stream; audioChunksRef.current = [];  // Full-call recorder for Evidence / Audit playback try { const mediaRecorder = new MediaRecorder(stream); mediaRecorderRef.current = mediaRecorder; mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) { audioChunksRef.current.push(event.data); } }; mediaRecorder.onstop = () => { if (audioChunksRef.current.length > 0 && currentCase) { const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' }); const audioUrl = URL.createObjectURL(audioBlob); updateCase(currentCase.id, { audioUrl }); } }; mediaRecorder.start(1000); } catch { // Optional full-call archive recording; live VAD capture runs independently }  const vadCapture = new VadAudioCapture({ onVadStatusChange: (status) => setVadStatus(status), onAudioLevel: (rms) => setAudioLevel(rms), onSpeechSegment: (segment) => { segmentQueueRef.current.push(segment); drainSegmentQueue(); }, onError: (msg) => setMicError(msg), });  await vadCapture.start(stream); vadCaptureRef.current = vadCapture;  setIsRunning(true); isRunningRef.current = true; setMicError(null); setRawError(null); } catch (err: any) { setMicError(err.message \vert{}\vert{} 'Microphone access denied or unavailable.'); setIsRunning(false); isRunningRef.current = false; setVadStatus('idle'); } };  const stopListening = () => { isRunningRef.current = false;  if (vadCaptureRef.current) { vadCaptureRef.current.stop(); vadCaptureRef.current = null; }  if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') { try { mediaRecorderRef.current.stop(); } catch {} } mediaRecorderRef.current = null;  if (streamRef.current) { streamRef.current.getTracks().forEach((track) => track.stop()); streamRef.current = null; }  setIsRunning(false); setVadStatus('idle'); setAudioLevel(0); };  const analyzeTranscript = async (currentTurns: any[]) => { try { const base = backendUrl.trim() \vert{}\vert{} window.location.origin; const res = await fetch(`${base}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceLanguage,
          turns: currentTurns,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Analysis failed');
      }
      const data = await res.json();
      if (data) {
        setAnalysis((prev: any) => ({ ...prev, ...data }));
        setAnalysisUnavailable(false);
      }
    } catch (err: any) {
      console.warn('Failed to run AI analysis:', err.message);
      setAnalysisUnavailable(true);
    }
  };

  const toggleSpeaker = (idx: number) => {
    setTurns((prev) => {
      const next = [...prev];
      if (next[idx] && !next[idx].isNote) {
        const s = next[idx].speaker;
        const newSpeaker = s === 'Operator' ? 'Caller' : 'Operator';
        next[idx] = {
          ...next[idx],
          speaker: newSpeaker,
        };

        if (currentCase) {
          const newLog = {
            time: new Date().toLocaleTimeString('en-US', { hour12: false }),
            type: 'operator',
            actor: 'OP-01',
            message: `Manually toggled speaker label from ${s} to${newSpeaker} at turn ${idx + 1}`, }; updateCase(currentCase.id, { auditLog: [...(currentCase.auditLog \vert{}\vert{} []), newLog], }); } } return next; }); };  const swapAllSpeakers = () => { setTurns((prev) => prev.map((t) => { if (t.isNote) return t; const nextSpeaker = t.speaker === 'Operator' ? 'Caller' : t.speaker === 'Caller' ? 'Operator' : t.speaker; return { ...t, speaker: nextSpeaker }; }) );  // Also swap stored acoustic voice profiles & cached reference audio snippets so future turns stay aligned const prevOpProfile = operatorProfileRef.current; const prevCallerProfile = callerProfileRef.current; setOperatorVoiceProfile(prevCallerProfile); setCallerVoiceProfile(prevOpProfile); operatorProfileRef.current = prevCallerProfile; callerProfileRef.current = prevOpProfile;  const prevOpAudio = operatorRefAudioRef.current; operatorRefAudioRef.current = callerRefAudioRef.current; callerRefAudioRef.current = prevOpAudio;  setToastMessage('Swapped Operator & Caller labels + acoustic voice profiles'); setTimeout(() => setToastMessage(null), 2500); };  const renderTextWithHighlights = (text: any, signals: any[]) => { if (!text) return null; const processedText = typeof text === 'object' ? text.en \vert{}\vert{} text.english \vert{}\vert{} Object.values(text)[0] \vert{}\vert{} JSON.stringify(text) : String(text);  if (!signals \vert{}\vert{} !signals.length) return <span>{processedText}</span>; const dangerWords = signals.flatMap((s) => { const str = typeof s === 'string' ? s : s && s.keyword ? s.keyword : ''; return str .toLowerCase() .replace(/["']/g, '') .split(/\s+/); }); const validWords = dangerWords.filter((w) => w.length > 3); if (validWords.length === 0) return <span>{processedText}</span>; const escaped = validWords.map((w) => w.replace(/[.*+?^${}()\vert{}[\]\\]/g, '\\$&')); const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
    const parts = processedText.split(regex);

    return parts.map((part, i) => {
      if (!part) return <span key={i}>{part}</span>;
      if (validWords.some((dw) => dw.toLowerCase() === part.toLowerCase())) {
        return (
          <span key={i} className="text-[var(--critical)] bg-[var(--critical)]/15 px-1 font-bold">
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  const riskScore = analysis.riskScore || 0;
  const riskSignals = analysis.signals || [];
  const recommendedActions = analysis.recommendedActions || [];
  const suggestedQuestions = analysis.suggestedQuestions || [];
  const riskPriority = riskScore >= 85 ? 'critical' : riskScore >= 50 ? 'high' : 'low';

  if (!currentCase) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)] gap-4">
        <p className="text-sm font-mono">No active case selected.</p>
        <button
          onClick={createNewCase}
          className="px-4 py-2 bg-[var(--info-tag)] text-black font-bold text-xs uppercase hover:bg-white transition-colors"
        >
          Start New Call
        </button>
      </div>
    );
  }

  const getVadBadge = () => {
    if (!isRunning) {
      return {
        dotClass: 'bg-[var(--text-secondary)]',
        textClass: 'text-[var(--text-secondary)]',
        label: 'MIC IDLE • VAD READY',
      };
    }
    if (isProcessingSegment) {
      return {
        dotClass: 'bg-[var(--info-tag)] animate-ping',
        textClass: 'text-[var(--info-tag)]',
        label: 'VAD: TRANSCRIBING SPEECH',
      };
    }
    if (vadStatus === 'speech') {
      return {
        dotClass: 'bg-[var(--critical)] animate-pulse',
        textClass: 'text-[var(--critical)]',
        label: 'VAD: SPEECH DETECTED',
      };
    }
    return {
      dotClass: 'bg-[var(--resolved)] animate-pulse',
      textClass: 'text-[var(--resolved)]',
      label: 'MIC LIVE • VAD MONITORING',
    };
  };

  const vadBadge = getVadBadge();

  return (
    <div className="flex flex-col h-full gap-2 overflow-hidden relative">
      {toastMessage && (
        <div className="fixed bottom-10 right-4 z-50 bg-[var(--info-tag)] text-black font-mono text-xs font-bold px-4 py-2 shadow-lg border border-white">
          {toastMessage}
        </div>
      )}

      {/* ACTIVE CALL HEADER / INGESTION BAR */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-[var(--bg-panel)] border border-[var(--border)] shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={currentCase.id}
            onChange={(e) => updateCaseId(currentCase.id, e.target.value)}
            className="font-mono text-base font-bold text-[var(--text-primary)] bg-transparent border-b border-transparent focus:border-[var(--info-tag)] hover:border-[var(--border)] outline-none w-28"
          />

          {/* Connection Status */}
          <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--bg-main)] border border-[var(--border)]">
            {isConnected === false ? (
              <XCircle className="w-3 h-3 text-[var(--critical)]" />
            ) : isConnected === true ? (
              <CheckCircle className="w-3 h-3 text-[var(--resolved)]" />
            ) : (
              <Activity className="w-3 h-3 text-[var(--text-secondary)]" />
            )}
            <span
              className={`text-xs font-mono ${
                isConnected === false
                  ? 'text-[var(--critical)]'
                  : isConnected === true
                  ? 'text-[var(--resolved)]'
                  : 'text-[var(--text-secondary)]'
              }`}
            >
              {isConnected === false ? 'BACKEND OFFLINE' : isConnected === true ? 'GEMINI AUDIO READY' : 'CONNECTING'}
            </span>
          </div>

          {/* Backend URL Config */}
          <input
            type="text"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            disabled={isRunning}
            className="bg-[var(--bg-main)] border border-[var(--border)] text-xs text-[var(--text-primary)] px-2 py-1 w-36 focus:outline-none focus:border-[var(--info-tag)] disabled:opacity-50"
            placeholder="Backend URL"
          />

          {/* Live Mic / VAD Status */}
          <div className="flex items-center gap-2 px-2.5 py-1 bg-[var(--bg-main)] border border-[var(--border)]">
            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${vadBadge.dotClass}`}></div>
            <span className={`text-xs font-mono ${vadBadge.textClass}`}>{vadBadge.label}</span>
            {isRunning && (
              <div className="w-12 h-1.5 bg-[var(--bg-panel)] border border-[var(--border)] overflow-hidden ml-1">
                <div
                  className={`h-full transition-all duration-75 ${ vadStatus === 'speech' ? 'bg-[var(--critical)]' : 'bg-[var(--resolved)]' }`} style={{ width: `${Math.max(8, Math.round(audioLevel * 100))}%` }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)] uppercase">Stress Vulnerability Index</span>
          {analysisUnavailable && (
            <span className="text-[10px] text-[var(--critical)] font-bold animate-pulse">RETRYING</span>
          )}
          <span
            className={`text-xs font-bold px-2 py-1 ${ riskScore >= 85 ? 'bg-[var(--critical)] text-[var(--bg-main)] border-[var(--critical)]' : riskScore >= 50 ? 'bg-[var(--high)] text-[var(--bg-main)] border-[var(--high)]' : 'bg-[var(--info-tag)] text-[var(--bg-main)] border-[var(--info-tag)]' }`} > {riskPriority.toUpperCase()} {riskScore}/100 </span> </div> </div>  {/* 3-COLUMN LAYOUT */} <div className="flex flex-1 gap-2 min-h-0 overflow-hidden"> {/* LEFT COL: Caller Details */} <div className="w-1/4 flex flex-col gap-2 min-h-0 overflow-y-auto"> <div className="flex flex-col bg-[var(--bg-panel)] border border-[var(--border)] flex-1 p-3 gap-3"> <h3 className="text-xs font-bold text-[var(--text-secondary)] uppercase border-b border-[var(--border)] pb-2"> Caller Profile </h3>  <div className="space-y-3 text-xs"> <div> <div className="text-[var(--text-secondary)] mb-1">Phone Number</div> <input type="text" className="font-mono text-sm bg-[var(--bg-main)] p-2 border border-[var(--border)] w-full outline-none focus:border-[var(--info-tag)] text-white" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="Enter phone number" /> </div> <div> <div className="text-[var(--text-secondary)] mb-1">Source Language</div> <select className="font-mono text-sm bg-[var(--bg-main)] p-2 border border-[var(--border)] uppercase w-full cursor-pointer outline-none focus:border-white text-white appearance-none" value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} > {LANGUAGES.map((lang) => ( <option key={lang.code} value={lang.code}> {lang.label} {lang.code !== 'auto' ? `(${lang.code})` : ''}
                    </option>
                  ))}
                </select>
                {(analysis?.detectedLanguage || metaData?.language) && (
                  <div className="mt-1 text-[10px] text-[var(--info-tag)] uppercase font-mono">
                    Detected: {analysis?.detectedLanguage || metaData?.language}
                  </div>
                )}
              </div>

              {/* Acoustic Diarization Voice Lock Status */}
              <div>
                <div className="text-[var(--text-secondary)] mb-1">Acoustic Speaker Lock</div>
                <div className="font-mono text-[10px] bg-[var(--bg-main)] p-2 border border-[var(--border)] space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[var(--info-tag)]">OPR VOICE:</span>
                    <span
                      className="text-[var(--text-primary)] truncate max-w-[140px]"
                      title={operatorVoiceProfile?.summary || ''}
                    >
                      {operatorVoiceProfile ? operatorVoiceProfile.summary || 'LOCKED' : 'Listening...'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--high)]">CLR VOICE:</span>
                    <span
                      className="text-[var(--text-primary)] truncate max-w-[140px]"
                      title={callerVoiceProfile?.summary || ''}
                    >
                      {callerVoiceProfile ? callerVoiceProfile.summary || 'LOCKED' : 'Listening...'}
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[var(--text-secondary)] mb-1">Caller Status</div>
                <div
                  className={`font-mono text-sm bg-[var(--bg-main)] p-2 border border-[var(--border)] ${
                    riskScore > 50 ? 'text-[var(--critical)]' : 'text-[var(--info-tag)]'
                  }`}
                >
                  {analysis.callerStatus || 'Unknown'}
                </div>
              </div>

              <div>
                <div className="text-[var(--text-secondary)] mb-1">Geolocation</div>
                <div className="flex flex-col gap-1 font-mono text-xs bg-[var(--bg-main)] p-2 border border-[var(--border)]">
                  <span>{analysis.extractedLocation || 'No address clues yet'}</span>
                  <span className="text-[10px] text-[var(--info-tag)] uppercase">
                    STATUS: {analysis.locationStatus || 'unknown'}
                  </span>
                </div>
              </div>

              <LocationConfidenceMap analysis={analysis} />
            </div>

            {micError && (
              <div className="mt-2 p-3 border border-[var(--critical)] bg-[var(--critical)]/10 text-[var(--critical)] text-xs">
                <strong>Microphone Error</strong>
                <p className="mt-1 opacity-80 break-words">{micError}</p>
              </div>
            )}
            {rawError && (
              <div className="mt-2 p-3 border border-[var(--critical)] bg-[var(--critical)]/10 text-[var(--critical)] text-xs">
                <strong>Pipeline Notice</strong>
                <p className="mt-1 opacity-80 break-words">{rawError}</p>
              </div>
            )}
          </div>
        </div>

        {/* CENTER COL: Transcript & Notes */}
        <div className="w-2/4 flex flex-col gap-2 min-h-0 overflow-hidden">
          <div className="flex flex-col bg-[var(--bg-panel)] border border-[var(--border)] flex-1 min-h-0 overflow-hidden">
            {/* Controls Header */}
            <div className="text-xs font-bold text-[var(--text-secondary)] uppercase border-b border-[var(--border)] p-2 bg-[var(--bg-panel)] shrink-0 flex flex-wrap justify-between items-center gap-2">
              <div className="flex items-center gap-2">
                <span>Live Transcript & Translation</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-[var(--bg-main)] border border-[var(--border)] text-[var(--info-tag)] font-mono">
                  {showEnglishTranslation ? 'ENGLISH' : 'ORIGINAL'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                />
                {turns.length > 0 && (
                  <>
                    <button
                      onClick={() => {
                        if (transcriptContainerRef.current) {
                          transcriptContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                          isUserScrolledUpRef.current = true;
                        }
                      }}
                      title="Scroll to top of transcript"
                      className="px-2 py-1 text-[10px] font-bold border transition-colors bg-[var(--bg-main)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--border)]"
                    >
                      TOP ⤒
                    </button>
                    <button
                      onClick={() => {
                        if (transcriptContainerRef.current) {
                          transcriptContainerRef.current.scrollTo({
                            top: transcriptContainerRef.current.scrollHeight,
                            behavior: 'smooth',
                          });
                          isUserScrolledUpRef.current = false;
                        }
                      }}
                      title="Scroll to latest line"
                      className="px-2 py-1 text-[10px] font-bold border transition-colors bg-[var(--bg-main)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--border)]"
                    >
                      END ⤓
                    </button>
                  </>
                )}
                <button
                  onClick={handleTranslateToggle}
                  disabled={turns.length === 0 || isTranslating}
                  title="Toggle between Original Language and English Translation"
                  className={`flex items-center gap-1 px-2 py-1 text-[10px] font-bold border transition-colors disabled:opacity-50 ${
                    showEnglishTranslation
                      ? 'bg-[var(--info-tag)] text-black border-[var(--info-tag)]'
                      : 'bg-[var(--bg-main)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--border)]'
                  }`}
                >
                  <Globe className="w-3 h-3" />
                  {isTranslating ? 'TRANSLATING...' : 'TRANSLATE'}
                </button>
                <button
                  onClick={swapAllSpeakers}
                  disabled={turns.length === 0}
                  title="Override: Swap Operator and Caller labels & voice profiles"
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold border transition-colors bg-[var(--bg-main)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50"
                >
                  <RefreshCw className="w-3 h-3" />
                  SWAP OPR/CALLER
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRunning || uploadState === 'uploading' || uploadState === 'processing'}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold border transition-colors bg-[var(--bg-main)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--border)] disabled:opacity-50"
                >
                  <span>⇧</span>
                  {uploadState === 'uploading'
                    ? 'UPLOADING...'
                    : uploadState === 'processing'
                    ? 'TRANSCRIBING...'
                    : 'UPLOAD AUDIO'}
                </button>
                <button
                  onClick={toggleIngestion}
                  disabled={uploadState === 'uploading' || uploadState === 'processing'}
                  className={`flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold border transition-colors ${
                    isRunning
                      ? 'bg-[var(--critical)] text-[var(--bg-main)] border-[var(--critical)]'
                      : 'bg-[var(--info-tag)] text-black border-[var(--info-tag)] hover:bg-white disabled:opacity-50'
                  }`}
                >
                  {isRunning ? <Square className="w-3 h-3" /> : <PlaySquare className="w-3 h-3" />}
                  {isRunning ? 'STOP LISTENING' : 'START LISTENING'}
                </button>
              </div>
            </div>

            {/* Transcript Flow */}
            <div
              ref={transcriptContainerRef}
              onScroll={handleTranscriptScroll}
              className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3 font-mono text-xs text-[var(--text-secondary)] bg-[var(--bg-main)] m-2 border border-[var(--border)]"
            >
              {turns.map((turn, idx) => {
                const origText =
                  (analysis.correctedOriginals && analysis.correctedOriginals[idx.toString()]) ||
                  turn.originalText ||
                  turn.text;
                const engText =
                  turn.englishText ||
                  (analysis.translations && analysis.translations[idx.toString()]) ||
                  origText;

                const primaryText = showEnglishTranslation ? engText : origText;
                const secondaryText =
                  origText && engText && origText.trim() !== engText.trim()
                    ? showEnglishTranslation
                      ? origText
                      : engText
                    : null;

                const isOperator = turn.speaker === 'Operator';

                return (
                  <div key={turn.id || idx} className="flex gap-3 items-start">
                    <span className="text-[var(--info-tag)] w-12 shrink-0">{turn.timestamp || '00:00'}</span>
                    <span
                      className={`font-bold w-20 shrink-0 truncate cursor-pointer hover:underline transition-colors ${ isOperator ? 'text-[var(--info-tag)]' : 'text-[var(--text-primary)]' }`} title="Click to toggle speaker label" onClick={() => toggleSpeaker(idx)} > {turn.speaker}: </span> <div className="flex flex-col gap-1 flex-1 min-w-0"> {turn.isNote ? ( <span className="italic opacity-80 text-[var(--info-tag)] font-sans">{turn.text}</span> ) : ( <> <div className="text-[var(--text-primary)] leading-relaxed break-words"> {renderTextWithHighlights(primaryText, riskSignals)} </div> {secondaryText && ( <div className="text-[11px] text-[var(--text-secondary)]/80 italic break-words"> {secondaryText} </div> )} {(turn.detectedLanguage \vert{}\vert{} turn.roleCorrected) && ( <div className="flex items-center gap-2 text-[9px] text-[var(--text-secondary)]/60 uppercase"> {turn.detectedLanguage && <span>[{turn.detectedLanguage}]</span>} {turn.roleCorrected && ( <span className="text-[var(--high)]">[Auto-corrected speaker]</span> )} </div> )} </> )} </div> </div> ); })}  {!isRunning && uploadState !== 'uploading' && uploadState !== 'processing' && turns.length === 0 && ( <div className="flex flex-col justify-center items-center h-full text-[var(--text-secondary)] gap-6 p-8"> <div className="text-center italic opacity-70"> No transcript data available. Choose an input method to begin autonomous Gemini audio ingestion. </div> <div className="flex gap-4"> <button onClick={toggleIngestion} className="flex flex-col items-center gap-2 p-6 border-2 border-[var(--border)] hover:border-[var(--info-tag)] hover:text-[var(--text-primary)] transition-colors bg-[var(--bg-panel)] w-48" > <Mic className="w-8 h-8 text-[var(--info-tag)]" /> <span className="font-bold text-sm">LIVE AUDIO (VAD)</span> <span className="text-[10px] opacity-70 text-center">16kHz WAV • Auto Diarization</span> </button> <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-2 p-6 border-2 border-[var(--border)] hover:border-[var(--info-tag)] hover:text-[var(--text-primary)] transition-colors bg-[var(--bg-panel)] w-48" > <span className="text-3xl font-bold text-[var(--info-tag)]">⇧</span> <span className="font-bold text-sm">UPLOAD FILE</span> <span className="text-[10px] opacity-70 text-center">MP3 / WAV Audio File</span> </button> </div> </div> )}  {isRunning && turns.length === 0 && ( <div className="flex justify-center items-center h-full text-[var(--text-secondary)] opacity-75 italic"> <div className="flex flex-col items-center gap-2 text-center"> <Mic className={`w-8 h-8 ${
                        vadStatus === 'speech' ? 'text-[var(--critical)] animate-bounce' : 'text-[var(--resolved)]'
                      }`}
                    />
                    <span>
                      {isProcessingSegment
                        ? 'Processing speech segment via Gemini Native Audio...'
                        : vadStatus === 'speech'
                        ? 'Speech detected — capturing 16kHz WAV utterance...'
                        : 'VAD active — speak into microphone (silence is filtered automatically)...'}
                    </span>
                  </div>
                </div>
              )}

              {(uploadState === 'uploading' || uploadState === 'processing') && turns.length === 0 && (
                <div className="flex justify-center items-center h-full text-[var(--text-secondary)] opacity-70 italic animate-pulse">
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-xl font-bold">...</span>
                    <span>
                      {uploadState === 'uploading'
                        ? 'Uploading audio...'
                        : 'Transcribing and diarizing with Gemini...'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Operator Notes */}
            <div className="p-2 pt-0 shrink-0">
              <textarea
                value={operatorNote}
                onChange={(e) => setOperatorNote(e.target.value)}
                onKeyDown={handleOperatorNoteSubmit}
                className="w-full h-16 bg-[var(--bg-main)] border border-[var(--border)] p-2 text-xs font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--info-tag)] resize-none"
                placeholder="Enter operator notes here... (Press Enter to submit, Shift+Enter for new line)"
              ></textarea>
            </div>
          </div>
        </div>

        {/* RIGHT COL: AI Insights / Actions */}
        <div className="w-1/4 flex flex-col gap-2 min-h-0 overflow-y-auto">
          {/* Risk Score Panel */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] flex flex-col">
            <div className="bg-[#25394B] p-2 border-b border-[var(--border)] font-bold text-xs uppercase flex justify-between items-center">
              <span>Stress Vulnerability Index</span>
              <AlertTriangle
                className={`w-4 h-4 ${ riskScore >= 85 ? 'text-[var(--critical)]' : riskScore >= 50 ? 'text-[var(--high)]' : 'text-[var(--info-tag)]' }`} /> </div> <div className="p-3 bg-[var(--bg-main)] space-y-2"> <div className="flex justify-between text-xs font-mono"> <span>SVI (VOCAL + CONTENT)</span> <span className={`${
                    riskScore >= 85
                      ? 'text-[var(--critical)]'
                      : riskScore >= 50
                      ? 'text-[var(--high)]'
                      : 'text-[var(--info-tag)]'
                  } font-bold`}
                >
                  {riskScore} / 100
                </span>
              </div>
              <div className="h-2 w-full bg-[var(--bg-panel)] border border-[var(--border)]">
                <div
                  className={`h-full transition-all duration-300 ${ riskScore >= 85 ? 'bg-[var(--critical)]' : riskScore >= 50 ? 'bg-[var(--high)]' : 'bg-[var(--info-tag)]' }`} style={{ width: `${riskScore}%` }}
                ></div>
              </div>
              <div className="pt-1 flex justify-between items-center text-[10px] font-mono">
                <span className="text-[var(--text-secondary)]">
                  SENTIMENT: <strong className="text-[var(--text-primary)]">{analysis.sentiment || 'Neutral'}</strong>
                </span>
                <button
                  onClick={() => setShowSviDetails(!showSviDetails)}
                  className="flex items-center gap-1 uppercase text-[var(--info-tag)] hover:underline"
                >
                  <Info className="w-3 h-3" /> Details
                </button>
              </div>
              {showSviDetails && (
                <div className="mt-2 p-2 bg-[#1A2634] border border-[var(--border)] text-[10px] space-y-2 relative">
                  <button
                    onClick={() => setShowSviDetails(false)}
                    className="absolute top-1 right-1 text-[var(--text-secondary)] hover:text-white"
                  >
                    <XCircle className="w-3 h-3" />
                  </button>
                  <div className="font-bold text-[var(--text-primary)] uppercase border-b border-[var(--border)] pb-1 mb-1">
                    Vocal & Semantic Stress Factors
                  </div>
                  <div>
                    <span className="text-[var(--text-secondary)]">Detected Risk Signals:</span>
                    <ul className="list-disc pl-4 mt-1 text-[var(--high)]">
                      {riskSignals && riskSignals.length > 0 ? (
                        riskSignals.map((s: any, i: number) => (
                          <li key={i}>{typeof s === 'string' ? s : s.category || s.keyword}</li>
                        ))
                      ) : (
                        <li>None</li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <span className="text-[var(--text-secondary)]">Vocal & Acoustic Cues:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {analysis.emotionalFactors && analysis.emotionalFactors.length > 0 ? (
                        analysis.emotionalFactors.map((ef: string, i: number) => (
                          <span
                            key={i}
                            className="px-1.5 py-0.5 bg-[var(--bg-panel)] border border-[var(--border)] rounded-sm text-[var(--text-primary)]"
                          >
                            {ef}
                          </span>
                        ))
                      ) : (
                        <span className="italic text-[var(--text-secondary)]">Analyzing audio prosody...</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Risk Signals */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] flex flex-col min-h-[100px]">
            <div className="bg-[#25394B] p-2 border-b border-[var(--border)] font-bold text-xs uppercase flex justify-between items-center">
              <span>Detected Risk Signals</span>
              <Activity className="w-4 h-4 text-[var(--info-tag)]" />
            </div>
            <div className="p-2 bg-[var(--bg-main)] text-xs font-mono space-y-1 flex-1">
              {riskSignals.length > 0 ? (
                riskSignals.map((sig: any, i: number) => (
                  <div key={i} className="flex gap-2 p-1 border-b border-[var(--border)] text-[var(--text-primary)]">
                    <span className="text-[var(--critical)] shrink-0">⚠</span>
                    <span>
                      {typeof sig === 'string' ? sig : `${sig.keyword \vert{}\vert{} sig.category}:${sig.description || ''}`}
                    </span>
                  </div>
                ))
              ) : (
                <div className="text-[var(--text-secondary)] italic p-1">No major risk signals detected.</div>
              )}
            </div>
          </div>

          {/* Suggested Follow-ups */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] flex flex-col min-h-[100px]">
            <div className="bg-[#25394B] p-2 border-b border-[var(--border)] font-bold text-xs uppercase flex justify-between items-center">
              <span>Suggested Questions</span>
              <MessageSquare className="w-4 h-4 text-[var(--info-tag)]" />
            </div>
            <div className="p-2 bg-[var(--bg-main)] text-xs space-y-2 text-[var(--text-secondary)] flex-1">
              {suggestedQuestions.length > 0 ? (
                suggestedQuestions.map((q: string, i: number) => (
                  <div
                    key={i}
                    className="p-2 border border-[var(--border)] bg-[var(--bg-panel)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    "{q}"
                  </div>
                ))
              ) : (
                <div className="italic p-1">Listening for context...</div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="bg-[var(--bg-panel)] border border-[var(--border)] flex flex-col mt-auto shrink-0">
            <details className="group" open>
              <summary className="bg-[#25394B] p-2 border-b border-[var(--border)] font-bold text-xs uppercase cursor-pointer flex justify-between items-center list-none [&::-webkit-details-marker]:hidden">
                <span>Recommended Actions</span>
                <ChevronDown className="w-4 h-4 text-[var(--info-tag)] group-open:rotate-180 transition-transform" />
              </summary>
              <div className="p-2 bg-[var(--bg-main)] grid grid-cols-1 gap-2">
                {recommendedActions.length > 0 ? (
                  recommendedActions.map((action: string, i: number) => (
                    <button
                      key={i}
                      onClick={() => handleRecommendedAction(action)}
                      className={`w-full p-2 font-bold text-xs uppercase border transition-all duration-300 flex items-center justify-center gap-2 ${
                        clickedActions[action]
                          ? 'bg-[var(--info-tag)] text-black border-[var(--info-tag)] opacity-80'
                          : action.includes('Critical') || action.includes('Dispatch')
                          ? 'bg-[var(--critical)] text-[var(--bg-main)] border-[var(--critical)] hover:opacity-90'
                          : 'bg-[var(--bg-panel)] text-[var(--text-primary)] border-[var(--border)] hover:bg-[var(--border)] hover:opacity-90'
                      }`}
                    >
                      {clickedActions[action] && <CheckCircle className="w-4 h-4" />}
                      {clickedActions[action] ? 'Action Completed' : action}
                    </button>
                  ))
                ) : (
                  <button className="w-full p-2 bg-[var(--bg-panel)] text-[var(--text-secondary)] font-bold text-xs uppercase border border-[var(--border)] opacity-50 cursor-not-allowed">
                    Awaiting Analysis
                  </button>
                )}
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceAuditView({
  currentCase,
  updateCase,
}: {
  currentCase: any;
  updateCase: (id: string, updates: any) => void;
}) {
  if (!currentCase) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-secondary)] font-mono text-sm">
        No case selected for audit.
      </div>
    );
  }

  const hasData =
    (currentCase.turns && currentCase.turns.length > 0) ||
    (currentCase.analysis && Object.keys(currentCase.analysis).length > 0 && currentCase.analysis.riskScore > 0);

  if (!hasData && currentCase.status !== 'RESOLVED') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)] font-mono gap-2">
        <p className="text-sm font-bold">Waiting for Call Analytics...</p>
        <p className="text-xs opacity-70">Begin the active call recording to populate audit data.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-panel)] border border-[var(--border)] p-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border)] pb-3 shrink-0">
        <div className="flex items-center gap-4">
          <h2 className="font-mono text-base font-bold text-[var(--text-primary)]">
            {currentCase.id} - AUDIT RECORD
          </h2>
          <div className="text-xs font-mono text-[var(--text-secondary)]">
            Status:{' '}
            <span
              className={`font-bold ${ currentCase.status === 'RESOLVED' ? 'text-[var(--resolved)]' : 'text-[var(--critical)]' }`} > {currentCase.status} </span> </div> {currentCase.status !== 'RESOLVED' && ( <button onClick={() => updateCase(currentCase.id, { status: 'RESOLVED', priority: 'RESOLVED' })} className="px-3 py-1 bg-[var(--resolved)] text-black font-bold uppercase text-[10px] hover:bg-white transition-colors" > Close Case </button> )} </div>  <button onClick={() => { if (!currentCase.turns) return; const text = currentCase.turns .map((t: any) => { if (t.isNote) return `[SYSTEM] ${t.fullNote}`;
                const orig = t.originalText || t.text;
                const eng = t.englishText && t.englishText !== orig ? ` | EN: ${t.englishText}` : ''; return `[${t.timestamp || '00:00'}] [${t.speaker \vert{}\vert{} 'Unknown'}]${orig}${eng}`; }) .join('\n'); const blob = new Blob([text], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${currentCase.id}-transcript.txt`;
            a.click();
          }}
          className="flex items-center gap-2 px-3 py-1 bg-[var(--bg-main)] border border-[var(--border)] text-xs font-mono hover:bg-[var(--border)] hover:text-white transition-colors cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          EXPORT TRANSCRIPT
        </button>
      </div>

      <div className="flex gap-4 mt-4 flex-1 min-h-0 overflow-hidden">
        {/* Audio / Technical Meta */}
        <div className="w-1/2 flex flex-col gap-4">
          <div className="border border-[var(--border)] bg-[var(--bg-main)] p-4 flex flex-col gap-4">
            <h3 className="text-xs font-bold text-[var(--text-secondary)] uppercase flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Volume2 className="w-4 h-4" /> Original Audio Recording
              </div>
              {currentCase.audioUrl && (
                <a
                  href={currentCase.audioUrl}
                  download={`case-${currentCase.id}-audio.wav`} className="text-[var(--info-tag)] hover:text-[var(--text-primary)] flex items-center gap-1 transition-colors" > <Download className="w-3 h-3" /> DOWNLOAD </a> )} </h3>  {currentCase.audioUrl ? ( <AudioWaveform url={currentCase.audioUrl} /> ) : ( <div className="h-16 w-full bg-[var(--bg-panel)] border border-[var(--border)] flex items-center justify-center overflow-hidden px-1 space-x-[2px]"> {Array.from({ length: 60 }).map((_, i) => { const h = Math.sin(i * 0.5 + currentCase.id.charCodeAt(0)) * 40 + 50; return ( <div key={i} className="w-1 bg-[var(--info-tag)]" style={{ height: `${h}%`, opacity: currentCase.status === 'RESOLVED' ? 0.3 : i < 30 ? 1 : 0.3 }}
                    ></div>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 text-xs font-mono mt-2">
              <div>
                <div className="text-[var(--text-secondary)]">Duration</div>
                <div>
                  {currentCase.turns && currentCase.turns.length > 0
                    ? `00:${Math.floor(currentCase.turns.length * 2.5) .toString() .padStart(2, '0')}` : '00:00'} </div> </div> <div> <div className="text-[var(--text-secondary)]">Format</div> <div>PCM / 16kHz / Mono WAV</div> </div> </div> </div> </div>  {/* Audit Log */} <div className="w-1/2 flex flex-col border border-[var(--border)] bg-[var(--bg-main)]"> <div className="bg-[#25394B] p-3 border-b border-[var(--border)] font-bold text-xs uppercase flex items-center gap-2"> <FileText className="w-4 h-4 text-[var(--info-tag)]" /> System Audit Log </div> <div className="flex-1 overflow-y-auto p-4 space-y-4 font-mono text-xs"> {currentCase.auditLog && currentCase.auditLog.map((log: any, idx: number) => { let colorClass = 'text-[var(--info-tag)]'; if (log.type === 'operator') colorClass = 'text-[var(--text-secondary)]'; if (log.type === 'ai') colorClass = 'text-[var(--high)]'; if (log.type === 'alert') colorClass = 'text-[var(--critical)]';  return ( <div key={idx} className="flex gap-4"> <span className="text-[var(--text-secondary)] w-24 shrink-0">{log.time}</span> <span className={`${colorClass} w-24 shrink-0`}>[{log.actor}]</span>
                    <span className="text-[var(--text-primary)]">{log.message}</span>
                  </div>
                );
              })}

            {currentCase.analysis && currentCase.analysis.riskScore > 0 && (
              <div className="flex gap-4">
                <span className="text-[var(--text-secondary)] w-24 shrink-0">Now</span>
                <span className="text-[var(--high)] w-24 shrink-0">[AI_ENGINE]</span>
                <span className="text-[var(--text-primary)]">
                  Real-time vocal + semantic risk assessment active. Score: {currentCase.analysis.riskScore}
                </span>
              </div>
            )}

            {currentCase.analysis && currentCase.analysis.riskScore > 80 && (
              <div className="flex gap-4">
                <span className="text-[var(--text-secondary)] w-24 shrink-0">Now</span>
                <span className="text-[var(--critical)] w-24 shrink-0">[ALERT]</span>
                <span className="text-[var(--text-primary)]">Critical Risk Detected.</span>
              </div>
            )}

            {currentCase.status === 'RESOLVED' && (
              <div className="flex gap-4">
                <span className="text-[var(--text-secondary)] w-24 shrink-0">Now</span>
                <span className="text-[var(--text-secondary)] w-24 shrink-0">[OPERATOR]</span>
                <span className="text-[var(--text-primary)]">Case officially closed and locked.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
