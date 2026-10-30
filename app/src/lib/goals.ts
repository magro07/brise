import { useStore } from "./store";

/** Goals: Der Agent arbeitet selbst am Ziel und prüft nach jeder Runde, ob es erreicht ist. */
const DONE = "ZIEL_ERREICHT";
const MAX_ROUNDS = 10;

const lastTurn = (sessionId: string) => {
  const items = useStore.getState().sessions[sessionId]?.items ?? [];
  const turn = [...items].reverse().find((i) => i.type === "turn");
  const answer = [...items].reverse().find((i) => i.type === "assistant");
  const prompt = items.map((i) => i.type).lastIndexOf("user");
  return { stop: turn?.type === "turn" ? turn.stopReason : "", text: answer?.type === "assistant" ? answer.text : "", worked: items.slice(prompt).some((i) => i.type === "tool") };
};

export async function runGoal(goal: string, send: (text: string, prefix: string, sessionId?: string) => Promise<void>) {
  const rule = `Arbeite selbstständig am Ziel, ohne Rückfragen, wenn du es vermeiden kannst. Prüfe am Ende jeder Runde ehrlich, ob es erreicht ist. Nur wenn es wirklich erreicht und geprüft ist, schreibe als letzte Zeile ${DONE}.`;
  await send(goal, rule);
  const sessionId = useStore.getState().activeSessionId;
  if (!sessionId) return;
  for (let round = 2; round <= MAX_ROUNDS; round++) {
    const { stop, text, worked } = lastTurn(sessionId);
    // Eine Runde ohne Werkzeuge ist eine Antwort, da gibt es nichts weiterzuarbeiten.
    if (stop !== "end_turn" || text.includes(DONE) || !worked) return;
    await send(`Weiter am Ziel, Runde ${round} von ${MAX_ROUNDS}: ${goal}`, rule, sessionId);
  }
}
