// Pluggable summarization provider. Returns observations for a session's
// messages. "none" provider => no-op (default). anthropic/openai call out only
// when explicitly configured with a key.

import {
  SUMMARIZE_PROVIDER,
  SUMMARIZE_MODEL,
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,
} from "../config.ts";
import { log } from "../log.ts";

export interface Observation {
  kind: string; // decision | bugfix | feature | discovery | change | note
  text: string;
}

const SYSTEM_PROMPT = `You compress a coding assistant conversation into a few durable memory observations.
Return ONLY a JSON array. Each item: {"kind": one of "decision"|"bugfix"|"feature"|"discovery"|"change"|"note", "text": one concise declarative sentence}.
Capture non-obvious facts, decisions and their rationale, fixes/workarounds, and discoveries. Skip pleasantries and routine actions. Max 8 items.`;

function buildUserPrompt(messages: Array<{ role: string; text: string }>): string {
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.text.slice(0, 1500)}`)
    .join("\n\n")
    .slice(0, 24000);
  return `Conversation:\n\n${transcript}\n\nReturn the JSON array of observations.`;
}

function parseObservations(raw: string): Observation[] {
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) {
      return [];
    }
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .filter((o) => o && typeof o.text === "string")
      .map((o) => ({ kind: String(o.kind || "note"), text: String(o.text) }))
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function callAnthropic(
  messages: Array<{ role: string; text: string }>,
): Promise<Observation[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SUMMARIZE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(messages) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}`);
  }
  const data = (await res.json()) as any;
  const text = data?.content?.[0]?.text ?? "";
  return parseObservations(text);
}

async function callOpenAI(
  messages: Array<{ role: string; text: string }>,
): Promise<Observation[]> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: SUMMARIZE_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(messages) },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`openai ${res.status}`);
  }
  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content ?? "";
  return parseObservations(text);
}

export async function summarize(
  messages: Array<{ role: string; text: string }>,
): Promise<Observation[]> {
  if (messages.length === 0) {
    return [];
  }
  try {
    if (SUMMARIZE_PROVIDER === "anthropic" && ANTHROPIC_API_KEY) {
      return await callAnthropic(messages);
    }
    if (SUMMARIZE_PROVIDER === "openai" && OPENAI_API_KEY) {
      return await callOpenAI(messages);
    }
  } catch (e) {
    log.warn("SUMMARIZE", "provider call failed", { error: String(e) });
    return [];
  }
  // "none" or missing key
  return [];
}
