// System 1: PersonaPlex WebSocket client
// Manages the connection to the Moshi voice model, handles audio/text streaming,
// and supports prompt-based reconnection for System 2 answer delivery.

import WebSocket from "ws";
import { config } from "./config.ts";

export type TalkerEvents = {
  onText: (text: string) => void;
  onTurnComplete: (fullText: string) => void;
  onAudio: (data: Uint8Array) => void;
  onConnected: () => void;
  onDisconnected: () => void;
};

export class Talker {
  private ws: WebSocket | null = null;
  private textPrompt: string;
  private currentTurnText = "";
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private events: TalkerEvents;

  constructor(initialPrompt: string, events: TalkerEvents) {
    this.textPrompt = initialPrompt;
    this.events = events;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Build the WebSocket URL with all query params PersonaPlex expects
  private buildUrl(): string {
    const protocol = "ws"; // PersonaPlex runs plain HTTP
    const base = `${protocol}://${config.personaplexHost}:${config.personaplexPort}${config.personaplexWsPath}`;
    const params = new URLSearchParams({
      text_temperature: config.textTemperature.toString(),
      text_topk: "25",
      audio_temperature: config.audioTemperature.toString(),
      audio_topk: "250",
      pad_mult: "0",
      text_seed: Math.round(Math.random() * 1000000).toString(),
      audio_seed: Math.round(Math.random() * 1000000).toString(),
      repetition_penalty_context: "64",
      repetition_penalty: "1",
      text_prompt: this.textPrompt,
      voice_prompt: config.voicePrompt,
    });
    return `${base}?${params.toString()}`;
  }

  connect(): void {
    if (this.ws) {
      console.log("[talker] Already connected, closing first");
      this.disconnect();
    }

    const url = this.buildUrl();
    console.log("[talker] Connecting to PersonaPlex...");

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.on("open", () => {
      console.log("[talker] WebSocket open, waiting for handshake");
    });

    this.ws.on("message", (data: ArrayBuffer) => {
      const bytes = new Uint8Array(data);
      if (bytes.length === 0) return;

      const kind = bytes[0];
      const payload = bytes.slice(1);

      switch (kind) {
        case 0x00: // Handshake
          console.log("[talker] Handshake received, connected!");
          this.events.onConnected();
          break;

        case 0x01: // Audio
          this.events.onAudio(payload);
          break;

        case 0x02: { // Text token
          const text = new TextDecoder().decode(payload);
          this.events.onText(text);

          // Accumulate turn text, detect turn completion by silence
          this.currentTurnText += text;
          if (this.turnTimer) clearTimeout(this.turnTimer);
          this.turnTimer = setTimeout(() => {
            if (this.currentTurnText.trim()) {
              this.events.onTurnComplete(this.currentTurnText.trim());
              this.currentTurnText = "";
            }
          }, config.turnSilenceMs);
          break;
        }

        case 0x04: { // Metadata
          const json = new TextDecoder().decode(payload);
          console.log("[talker] Metadata:", json);
          break;
        }
      }
    });

    this.ws.on("close", (code) => {
      console.log(`[talker] Disconnected (code: ${code})`);
      this.ws = null;
      if (!this.intentionalDisconnect) {
        this.events.onDisconnected();
      }
    });

    this.ws.on("error", (err) => {
      console.error("[talker] WebSocket error:", err.message);
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.currentTurnText = "";
    this.ws?.close(1000);
    this.ws = null;
  }

  // Send user audio to PersonaPlex
  sendAudio(opusData: Uint8Array): void {
    if (!this.connected) return;
    const msg = new Uint8Array(1 + opusData.length);
    msg[0] = 0x01;
    msg.set(opusData, 1);
    this.ws!.send(msg);
  }

  // Update prompt and reconnect — the System 2 answer delivery mechanism
  async reconnectWithNewPrompt(prompt: string): Promise<void> {
    console.log("[talker] Reconnecting with new prompt...");
    this.textPrompt = prompt;
    this.disconnect();
    // Wait for PersonaPlex to release session lock
    await new Promise((r) => setTimeout(r, config.reconnectDelayMs));
    this.intentionalDisconnect = false;
    this.connect();
  }
}
