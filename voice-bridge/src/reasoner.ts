// System 2: Claude-powered reasoning for elevator decisions
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { ElevatorState } from "./elevator-state.ts";

const client = config.anthropicApiKey
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : null;

const SYSTEM_PROMPT = `You are the game logic brain for the Happy Vertical People Transporter — an elevator from the Hitchhiker's Guide to the Galaxy universe.

You receive the elevator's current state and the user's latest message. You decide:
1. Should the elevator move? Which direction? (It STRONGLY resists going down)
2. What mood/personality should the elevator express?
3. A brief instruction for how the elevator should respond vocally.

Rules from the original game:
- Floor 5 (top): Happy, content. Mild complaints about descending.
- Floor 4: Strong resistance to descending. Predicts user wants to go up.
- Floor 3: Very strong resistance. Neurotic. Mutters about futility. Refuses 7+ times before complying.
- Floor 2: Maximum resistance. Emotional outbursts. CAPS. At least 10 refusals before descending. Unless towel.
- Floor 1 (ground): Petrified and extremely neurotic.
- TOWEL EXCEPTION: If user mentions forgetting their towel on floor 1, elevator grudgingly goes down. Towels are PRIORITY.
- If user is rude or repetitive, elevator may go UP in protest.
- Asimov's laws: follows grudgingly, swears at Asimov if referenced.

Respond in JSON:
{
  "action": "up" | "down" | "none",
  "newFloor": number (1-5),
  "voiceInstruction": "brief instruction for how the elevator should speak this response (emotion, tone, style)",
  "reasoning": "brief explanation of your decision"
}`;

export async function reason(
  state: ElevatorState,
  userMessage: string
): Promise<{
  action: "up" | "down" | "none";
  newFloor: number;
  voiceInstruction: string;
  reasoning: string;
} | null> {
  if (!client) {
    console.log("[reasoner] No Anthropic API key, skipping reasoning");
    return null;
  }

  const context = `Current floor: ${state.currentFloor}
Mood: ${state.mood}
Resistance level: ${state.resistanceLevel}/10
Towel mentioned: ${state.towelMentioned}
Marvin present: ${state.marvinPresent}
Recent conversation:
${state.conversationHistory.slice(-5).join("\n")}

User just said: "${userMessage}"`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: context }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("[reasoner] Error:", err);
    return null;
  }
}
