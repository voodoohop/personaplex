// Elevator Voice Bridge Server
// Sits between browser and PersonaPlex, adding Claude-powered reasoning.
//
// Browser <--WS--> Bridge <--WS--> PersonaPlex (Moshi 7B)
//                    |
//                    +---HTTP---> Claude (System 2 reasoning)

import { Hono } from "hono";
import { serve } from "bun";
import { config } from "./config.ts";
import { Talker, type TalkerEvents } from "./talker.ts";
import { reason } from "./reasoner.ts";
import {
  createInitialState,
  updateStateForFloor,
  addConversationTurn,
  type ElevatorState,
} from "./elevator-state.ts";
import { buildTextPrompt } from "./prompt-builder.ts";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ ok: true }));

// Serve a minimal test page
app.get("/", (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><title>Elevator Voice Bridge</title></head>
<body style="font-family: monospace; max-width: 600px; margin: 40px auto; padding: 20px;">
  <h1>Elevator Voice Bridge</h1>
  <p>Connect via WebSocket at <code>ws://localhost:${config.port}/ws</code></p>
  <p>PersonaPlex: <code>${config.personaplexHost}:${config.personaplexPort}</code></p>
  <div id="status">Disconnected</div>
  <div id="log" style="background: #1a1a2e; color: #0f0; padding: 10px; height: 300px; overflow-y: auto; margin-top: 10px;"></div>
  <script>
    const log = document.getElementById('log');
    const status = document.getElementById('status');
    const ws = new WebSocket('ws://localhost:${config.port}/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { status.textContent = 'Connected'; };
    ws.onclose = () => { status.textContent = 'Disconnected'; };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data);
        const div = document.createElement('div');
        div.textContent = JSON.stringify(msg);
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
      }
    };
  </script>
</body>
</html>`);
});

// Main WebSocket endpoint — bridges browser to PersonaPlex with reasoning
const server = serve({
  port: config.port,
  fetch: app.fetch,
  websocket: {
    open(ws) {
      console.log("[bridge] Browser connected");

      let state: ElevatorState = createInitialState();
      let system2Active = false;
      let talkerStreamingText = "";

      // Build initial prompt
      const initialPrompt = buildTextPrompt(state);

      // Set up Talker (PersonaPlex connection)
      const talkerEvents: TalkerEvents = {
        onConnected() {
          ws.send(JSON.stringify({ type: "status", status: "connected" }));
          ws.send(
            JSON.stringify({
              type: "state",
              floor: state.currentFloor,
              mood: state.mood,
            })
          );
        },

        onDisconnected() {
          ws.send(JSON.stringify({ type: "status", status: "disconnected" }));
        },

        onText(text: string) {
          talkerStreamingText += text;
          // Forward text tokens to browser (unless System 2 is active)
          if (!system2Active) {
            ws.send(JSON.stringify({ type: "text", text }));
          }
        },

        onTurnComplete(fullText: string) {
          console.log(`[bridge] Elevator said: "${fullText.slice(0, 80)}..."`);
          state = addConversationTurn(state, "elevator", fullText);
          talkerStreamingText = "";

          if (!system2Active) {
            ws.send(
              JSON.stringify({ type: "turn", speaker: "elevator", text: fullText })
            );
          }
        },

        onAudio(data: Uint8Array) {
          // Forward audio to browser (binary, prefixed with 0x01)
          if (!system2Active) {
            const msg = new Uint8Array(1 + data.length);
            msg[0] = 0x01;
            msg.set(data, 1);
            ws.send(msg.buffer);
          }
        },
      };

      const talker = new Talker(initialPrompt, talkerEvents);
      talker.connect();

      // Handle messages from browser
      ws.data = {
        talker,
        state: () => state,
        setState: (s: ElevatorState) => {
          state = s;
        },
        setSystem2Active: (v: boolean) => {
          system2Active = v;
        },
      };
    },

    async message(ws, data) {
      const sessionData = ws.data as {
        talker: Talker;
        state: () => ElevatorState;
        setState: (s: ElevatorState) => void;
        setSystem2Active: (v: boolean) => void;
      };

      // Binary data = audio from browser, forward to PersonaPlex
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        if (bytes[0] === 0x01) {
          sessionData.talker.sendAudio(bytes.slice(1));
        }
        return;
      }

      // Text data = JSON commands from browser
      try {
        const msg = JSON.parse(data as string);

        if (msg.type === "user_text") {
          // User typed or spoke something — route through System 2
          const userText = msg.text as string;
          console.log(`[bridge] User said: "${userText}"`);

          let state = sessionData.state();
          state = addConversationTurn(state, "user", userText);
          sessionData.setState(state);

          // Activate System 2 (Claude reasoning)
          sessionData.setSystem2Active(true);
          ws.send(JSON.stringify({ type: "thinking", active: true }));

          const decision = await reason(state, userText);

          if (decision) {
            console.log(
              `[bridge] Claude decided: ${decision.action} -> floor ${decision.newFloor} (${decision.reasoning})`
            );

            // Update state
            state = updateStateForFloor(state, decision.newFloor);
            sessionData.setState(state);

            // Build new prompt with Claude's voice instruction
            const newPrompt = buildTextPrompt(state, decision.voiceInstruction);

            // Send state update to browser
            ws.send(
              JSON.stringify({
                type: "state",
                floor: state.currentFloor,
                mood: state.mood,
                action: decision.action,
                reasoning: decision.reasoning,
              })
            );

            // Reconnect PersonaPlex with new prompt (System 2 answer delivery)
            sessionData.setSystem2Active(false);
            ws.send(JSON.stringify({ type: "thinking", active: false }));
            await sessionData.talker.reconnectWithNewPrompt(newPrompt);
          } else {
            // No reasoning available, just unmute
            sessionData.setSystem2Active(false);
            ws.send(JSON.stringify({ type: "thinking", active: false }));
          }
        }
      } catch (err) {
        console.error("[bridge] Error processing message:", err);
      }
    },

    close(ws) {
      console.log("[bridge] Browser disconnected");
      const sessionData = ws.data as { talker: Talker } | undefined;
      sessionData?.talker?.disconnect();
    },
  },
});

console.log(`[bridge] Elevator Voice Bridge running on http://localhost:${config.port}`);
console.log(`[bridge] PersonaPlex target: ${config.personaplexHost}:${config.personaplexPort}`);
console.log(`[bridge] Claude API: ${config.anthropicApiKey ? "configured" : "NOT configured (System 2 disabled)"}`);
