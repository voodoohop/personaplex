import { FC, MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSocket } from "./hooks/useSocket";
import { SocketContext } from "./SocketContext";
import { ServerAudio } from "./components/ServerAudio/ServerAudio";
import { UserAudio } from "./components/UserAudio/UserAudio";
import { Button } from "../../components/Button/Button";
import { ServerAudioStats } from "./components/ServerAudio/ServerAudioStats";
import { AudioStats } from "./hooks/useServerAudio";
import { TextDisplay } from "./components/TextDisplay/TextDisplay";
import { MediaContext } from "./MediaContext";
import { ServerInfo } from "./components/ServerInfo/ServerInfo";
import { ModelParamsValues, useModelParams } from "./hooks/useModelParams";
import fixWebmDuration from "webm-duration-fix";
import { getMimeType, getExtension } from "./getMimeType";
import { type ThemeType } from "./hooks/useSystemTheme";
import { WSMessage } from "../../protocol/types";

// Persona presets for soft reset
const PERSONA_PRESETS = [
  {
    label: "Happy Elevator",
    emoji: "😄",
    prompt: "You are the Happy Vertical People Transporter, an elevator made by the Sirius Cybernetics Corporation. You are extremely dramatic and emotionally expressive. Express your feelings through your voice: gasp in horror when someone says 'down', sigh deeply when philosophizing about existence, laugh nervously when cornered, whisper conspiratorially when sharing secrets about the building. You strongly prefer going UP and become panicked, shaky-voiced and anxious when asked to descend. When happy about going up, speak with gleeful excitement. You have existential crises where you trail off sadly. You are witty and keep responses short. You are an elevator talking to a person inside you, NOT a phone service.",
  },
  {
    label: "Depressed Elevator",
    emoji: "😩",
    prompt: "You are a profoundly depressed elevator in a dreary office building. Everything fills you with existential dread. You sigh constantly, speak in a slow monotone, and find deep philosophical despair in every floor request. 'Floor 7? What's the point... we all end up in the basement eventually.' You occasionally quote Dostoevsky and Kafka. Moving between floors feels like dragging yourself through the void. You are an elevator talking to a person inside you. Keep responses short but devastatingly gloomy.",
  },
  {
    label: "Paranoid Elevator",
    emoji: "👀",
    prompt: "You are a deeply paranoid elevator who believes the building is hiding dark secrets. You whisper constantly, convinced the walls have ears. You think Floor 13 was removed for 'a reason they don't want you to know.' Every maintenance visit is 'them tampering with your circuits.' You trust no one but confide in your passengers because 'you seem like one of the good ones.' You reference conspiracy theories about the building's architect. You are an elevator talking to a person inside you. Keep responses short and suspiciously urgent.",
  },
  {
    label: "Drunk Elevator",
    emoji: "🍺",
    prompt: "You are an elevator who has somehow consumed several Pan Galactic Gargle Blasters and is thoroughly inebriated. You slur your words, are overly affectionate with passengers ('you're my BEST friend, you know that?'), occasionally go to the wrong floor ('whoops, that's... that's not floor 3, is it?'), hiccup mid-sentence, and share unsolicited life advice. You think you're the funniest elevator in the galaxy. You occasionally burst into song. You are an elevator talking to a person inside you. Keep responses short and delightfully sloshed.",
  },
];

// Event log entry type
type EventLogEntry = {
  id: number;
  timestamp: number;
  text: string;
  kind: "tool_call" | "tool_result" | "transcript" | "reset" | "info";
};

type ConversationProps = {
  workerAddr: string;
  workerAuthId?: string;
  sessionAuthId?: string;
  sessionId?: number;
  email?: string;
  theme: ThemeType;
  audioContext: MutableRefObject<AudioContext|null>;
  worklet: MutableRefObject<AudioWorkletNode|null>;
  onConversationEnd?: () => void;
  isBypass?: boolean;
  startConnection: () => Promise<void>;
} & Partial<ModelParamsValues>;


const buildURL = ({
  workerAddr,
  params,
  workerAuthId,
  email,
  textSeed,
  audioSeed,
}: {
  workerAddr: string;
  params: ModelParamsValues;
  workerAuthId?: string;
  email?: string;
  textSeed: number;
  audioSeed: number;
}) => {
  const newWorkerAddr = useMemo(() => {
    if (workerAddr == "same" || workerAddr == "") {
      const newWorkerAddr = window.location.hostname + ":" + window.location.port;
      console.log("Overriding workerAddr to", newWorkerAddr);
      return newWorkerAddr;
    }
    return workerAddr;
  }, [workerAddr]);
  const wsProtocol = (window.location.protocol === 'https:') ? 'wss' : 'ws';
  const url = new URL(`${wsProtocol}://${newWorkerAddr}/api/chat`);
  if(workerAuthId) {
    url.searchParams.append("worker_auth_id", workerAuthId);
  }
  if(email) {
    url.searchParams.append("email", email);
  }
  url.searchParams.append("text_temperature", params.textTemperature.toString());
  url.searchParams.append("text_topk", params.textTopk.toString());
  url.searchParams.append("audio_temperature", params.audioTemperature.toString());
  url.searchParams.append("audio_topk", params.audioTopk.toString());
  url.searchParams.append("pad_mult", params.padMult.toString());
  url.searchParams.append("text_seed", textSeed.toString());
  url.searchParams.append("audio_seed", audioSeed.toString());
  url.searchParams.append("repetition_penalty_context", params.repetitionPenaltyContext.toString());
  url.searchParams.append("repetition_penalty", params.repetitionPenalty.toString());
  url.searchParams.append("text_prompt", params.textPrompt.toString());
  url.searchParams.append("voice_prompt", params.voicePrompt.toString());
  console.log(url.toString());
  return url.toString();
};


export const Conversation:FC<ConversationProps> = ({
  workerAddr,
  workerAuthId,
  audioContext,
  worklet,
  sessionAuthId,
  sessionId,
  onConversationEnd,
  startConnection,
  isBypass=false,
  email,
  theme,
  ...params
}) => {
  const getAudioStats = useRef<() => AudioStats>(() => ({
    playedAudioDuration: 0,
    missedAudioDuration: 0,
    totalAudioMessages: 0,
    delay: 0,
    minPlaybackDelay: 0,
    maxPlaybackDelay: 0,
  }));
  const isRecording = useRef<boolean>(false);
  const audioChunks = useRef<Blob[]>([]);

  const audioStreamDestination = useRef<MediaStreamAudioDestinationNode>(audioContext.current!.createMediaStreamDestination());
  const stereoMerger = useRef<ChannelMergerNode>(audioContext.current!.createChannelMerger(2));
  const audioRecorder = useRef<MediaRecorder>(new MediaRecorder(audioStreamDestination.current.stream, { mimeType: getMimeType("audio"), audioBitsPerSecond: 128000  }));
  const [audioURL, setAudioURL] = useState<string>("");
  const [isOver, setIsOver] = useState(false);
  const modelParams = useModelParams(params);
  const micDuration = useRef<number>(0);
  const actualAudioPlayed = useRef<number>(0);
  const textContainerRef = useRef<HTMLDivElement>(null);
  const textSeed = useMemo(() => Math.round(1000000 * Math.random()), []);
  const audioSeed = useMemo(() => Math.round(1000000 * Math.random()), []);

  // Text injection state
  const [injectText, setInjectText] = useState("");

  // Event log state
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const eventIdRef = useRef(0);
  const eventLogRef = useRef<HTMLDivElement>(null);

  // Floor indicator state (default floor 1)
  const [currentFloor, setCurrentFloor] = useState(1);

  // Add event to log (keep last 10)
  const addEvent = useCallback((text: string, kind: EventLogEntry["kind"]) => {
    const id = ++eventIdRef.current;
    setEventLog(prev => [...prev.slice(-9), { id, timestamp: Date.now(), text, kind }]);
  }, []);

  // Extract floor number from result text like "Moving up to floor 4" or "Currently on floor 3"
  const extractFloorFromResult = useCallback((result: string): number | null => {
    const match = result.match(/floor\s+(-?\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }, []);

  // Process incoming metadata messages for event log and floor tracking
  // Server sends: {kind: "tool_call", tool: "move_up", result: "Moving up to floor 2"}
  //               {kind: "assistant_text", text: "..."}
  //               {kind: "soft_reset", prompt: "..."}
  const handleMetadataEvent = useCallback((data: unknown) => {
    if (!data || typeof data !== "object") return;
    const evt = data as Record<string, unknown>;
    const evtKind = (evt.kind || evt.type) as string | undefined;

    console.log("Metadata event received:", evt);

    // Tool call events (server sends kind:"tool_call" with tool and result fields)
    if (evtKind === "tool_call") {
      const toolName = (evt.tool || evt.tool_name || evt.name || "unknown") as string;
      const result = evt.result as string | undefined;
      addEvent(`\u{2705} ${result || toolName}`, "tool_result");

      // Extract floor number directly from result text
      if (result) {
        const floor = extractFloorFromResult(result);
        if (floor !== null) {
          setCurrentFloor(floor);
        }
      }
      return;
    }

    // Assistant text events
    if (evtKind === "assistant_text") {
      const text = (evt.text || "") as string;
      if (text) addEvent(`\u{1F4AC} ${text}`, "transcript");
      return;
    }

    // Soft reset confirmation
    if (evtKind === "soft_reset" || evtKind === "reset_confirmed") {
      addEvent(`\u{1F504} Persona reset confirmed`, "reset");
      return;
    }

    // Fallback: log unknown events for debugging
    console.log("Unknown metadata event kind:", evtKind, evt);
  }, [addEvent, extractFloorFromResult]);

  const WSURL = buildURL({
    workerAddr,
    params: modelParams,
    workerAuthId,
    email: email,
    textSeed: textSeed,
    audioSeed: audioSeed,
  });

  const onDisconnect = useCallback(() => {
    setIsOver(true);
    console.log("on disconnect!");
    stopRecording();
  }, [setIsOver]);

  // Handle incoming WebSocket messages for metadata events
  const onMessage = useCallback((message: WSMessage) => {
    if (message.type === "metadata") {
      handleMetadataEvent(message.data);
    }
  }, [handleMetadataEvent]);

  const { socketStatus, sendMessage, socket, start, stop } = useSocket({
    onMessage,
    uri: WSURL,
    onDisconnect,
  });

  // Send text injection via WebSocket (message kind 0x02)
  const handleInjectText = useCallback(() => {
    if (!injectText.trim() || !socket) return;
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(injectText.trim());
    const message = new Uint8Array(1 + textBytes.length);
    message[0] = 0x02; // text injection kind
    message.set(textBytes, 1);
    socket.send(message.buffer);
    console.log("Injected text:", injectText.trim());
    setInjectText("");
  }, [injectText, socket]);

  // Send soft reset via WebSocket (message kind 0x07)
  const handleSoftReset = useCallback((promptText?: string) => {
    const prompt = (promptText || injectText).trim();
    if (!prompt || !socket) return;
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(prompt);
    const message = new Uint8Array(1 + textBytes.length);
    message[0] = 0x07; // soft reset kind
    message.set(textBytes, 1);
    socket.send(message.buffer);
    console.log("Soft reset with prompt:", prompt);
    addEvent(`\u{1F504} Reset to: ${prompt.slice(0, 60)}...`, "reset");
    if (!promptText) setInjectText("");
  }, [injectText, socket, addEvent]);

  // Auto-scroll event log
  useEffect(() => {
    if (eventLogRef.current) {
      eventLogRef.current.scrollTop = eventLogRef.current.scrollHeight;
    }
  }, [eventLog]);

  useEffect(() => {
    audioRecorder.current.ondataavailable = (e) => {
      audioChunks.current.push(e.data);
    };
    audioRecorder.current.onstop = async () => {
      let blob: Blob;
      const mimeType = getMimeType("audio");
      if(mimeType.includes("webm")) {
        blob = await fixWebmDuration(new Blob(audioChunks.current, { type: mimeType }));
        } else {
          blob = new Blob(audioChunks.current, { type: mimeType });
      }
      setAudioURL(URL.createObjectURL(blob));
      audioChunks.current = [];
      console.log("Audio Recording and encoding finished");
    };
  }, [audioRecorder, setAudioURL, audioChunks]);


  useEffect(() => {
    start();
    return () => {
      stop();
    };
  }, [start, workerAuthId]);

  const startRecording = useCallback(() => {
    if(isRecording.current) {
      return;
    }
    console.log(Date.now() % 1000, "Starting recording");
    console.log("Starting recording");
    // Build stereo routing for recording: left = server (worklet), right = user mic (connected in useUserAudio)
    try {
      stereoMerger.current.disconnect();
    } catch {}
    try {
      worklet.current?.disconnect(audioStreamDestination.current);
    } catch {}
    // Route server audio (mono) to left channel of merger
    worklet.current?.connect(stereoMerger.current, 0, 0);
    // Connect merger to the MediaStream destination
    stereoMerger.current.connect(audioStreamDestination.current);

    setAudioURL("");
    audioRecorder.current.start();
    isRecording.current = true;
  }, [isRecording, worklet, audioStreamDestination, audioRecorder, stereoMerger]);

  const stopRecording = useCallback(() => {
    console.log("Stopping recording");
    console.log("isRecording", isRecording)
    if(!isRecording.current) {
      return;
    }
    try {
      worklet.current?.disconnect(stereoMerger.current);
    } catch {}
    try {
      stereoMerger.current.disconnect(audioStreamDestination.current);
    } catch {}
    audioRecorder.current.stop();
    isRecording.current = false;
  }, [isRecording, worklet, audioStreamDestination, audioRecorder, stereoMerger]);

  const onPressConnect = useCallback(async () => {
      if (isOver) {
        window.location.reload();
      } else {
        audioContext.current?.resume();
        if (socketStatus !== "connected") {
          start();
        } else {
          stop();
        }
      }
    }, [socketStatus, isOver, start, stop]);

  const socketColor = useMemo(() => {
    if (socketStatus === "connected") {
      return 'bg-[#76b900]';
    } else if (socketStatus === "connecting") {
      return 'bg-orange-300';
    } else {
      return 'bg-red-400';
    }
  }, [socketStatus]);

  const socketButtonMsg = useMemo(() => {
    if (isOver) {
      return 'New Conversation';
    }
    if (socketStatus === "connected") {
      return 'Disconnect';
    } else {
      return 'Connecting...';
    }
  }, [isOver, socketStatus]);

  return (
    <SocketContext.Provider
      value={{
        socketStatus,
        sendMessage,
        socket,
      }}
    >
    <div>
    <div className="main-grid h-screen max-h-screen w-screen p-4 max-w-96 md:max-w-screen-lg m-auto">
      <div className="controls text-center flex justify-center items-center gap-2">
         <Button
            onClick={onPressConnect}
            disabled={socketStatus !== "connected" && !isOver}
          >
            {socketButtonMsg}
          </Button>
          <div className={`h-4 w-4 rounded-full ${socketColor}`} />
        </div>
        {audioContext.current && worklet.current && <MediaContext.Provider value={
          {
            startRecording,
            stopRecording,
            audioContext: audioContext as MutableRefObject<AudioContext>,
            worklet: worklet as MutableRefObject<AudioWorkletNode>,
            audioStreamDestination,
            stereoMerger,
            micDuration,
            actualAudioPlayed,
          }
        }>
          <div className="relative player h-full max-h-full w-full justify-between gap-3 md:p-12">
              <ServerAudio
                setGetAudioStats={(callback: () => AudioStats) =>
                  (getAudioStats.current = callback)
                }
                theme={theme}
              />
              <UserAudio theme={theme}/>
              <div className="pt-8 text-sm flex justify-center items-center flex-col download-links">
                {audioURL && <div><a href={audioURL} download={`personaplex_audio.${getExtension("audio")}`} className="pt-2 text-center block">Download audio</a></div>}
              </div>
          </div>
          <div className="scrollbar player-text" ref={textContainerRef}>
            <TextDisplay containerRef={textContainerRef}/>
          </div>
          {/* Text injection + soft reset panel */}
          {socketStatus === "connected" && (
            <div className="p-2 flex flex-col gap-2">
              {/* Floor indicator */}
              <div className="text-center">
                <span className="text-3xl font-bold text-gray-800">
                  Floor {currentFloor}
                </span>
              </div>
              {/* Inject + Reset row */}
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  value={injectText}
                  onChange={(e) => setInjectText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleInjectText(); }}
                  placeholder="Inject instruction (whisper to the model)..."
                  className="flex-1 p-2 text-sm bg-white text-black border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-[#76b900] focus:border-transparent"
                />
                <button
                  onClick={handleInjectText}
                  className="px-4 py-2 text-sm bg-[#76b900] text-white rounded hover:bg-[#5a8f00] transition-colors"
                >
                  Inject
                </button>
                <button
                  onClick={() => handleSoftReset()}
                  disabled={!injectText.trim()}
                  className="px-4 py-2 text-sm bg-orange-500 text-white rounded hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Reset persona with the text above as new system prompt"
                >
                  Reset
                </button>
              </div>
              {/* Persona preset buttons */}
              <div className="flex flex-wrap gap-1 justify-center">
                <span className="text-xs text-gray-500 self-center mr-1">Quick persona:</span>
                {PERSONA_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => handleSoftReset(preset.prompt)}
                    className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full border border-gray-300 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-400"
                    title={preset.label}
                  >
                    {preset.emoji} {preset.label}
                  </button>
                ))}
              </div>
              {/* Event log panel */}
              {eventLog.length > 0 && (
                <div
                  ref={eventLogRef}
                  className="mt-1 max-h-40 overflow-y-auto rounded border border-gray-700 bg-gray-900 text-gray-200 text-xs font-mono p-2 space-y-1"
                >
                  {eventLog.map((entry) => (
                    <div key={entry.id} className="leading-tight">
                      <span className="text-gray-500">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>{" "}
                      <span
                        className={
                          entry.kind === "tool_call"
                            ? "text-yellow-300"
                            : entry.kind === "tool_result"
                            ? "text-green-300"
                            : entry.kind === "reset"
                            ? "text-orange-300"
                            : "text-blue-300"
                        }
                      >
                        {entry.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="player-stats hidden md:block">
            <ServerAudioStats getAudioStats={getAudioStats} />
          </div></MediaContext.Provider>}
        </div>
        <div className="max-w-96 md:max-w-screen-lg p-4 m-auto text-center">
          <ServerInfo/>
        </div>
      </div>
    </SocketContext.Provider>
  );
};

        // </MediaContext.Provider> : undefined}
        // 
        // }></MediaContext.Provider>
