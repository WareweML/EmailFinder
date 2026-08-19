/**
 * Claygent-style AI research column — Grok when XAI_API_KEY present.
 * Never invents emails; summarizes evidence / suggests next steps.
 */

export async function runAiColumn(input: {
  task: string;
  context: Record<string, unknown>;
}): Promise<{ ok: boolean; text: string; error?: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      text: "",
      error: "AI column unavailable (no API key in this environment)",
    };
  }
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content:
              "You are a B2B research analyst inside a Clay-like enrichment table. Be concise. Never invent email addresses or phone numbers. Use only provided context. Output plain text, max 120 words.",
          },
          {
            role: "user",
            content: `Task: ${input.task}\n\nContext JSON:\n${JSON.stringify(input.context).slice(0, 6000)}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      return { ok: false, text: "", error: `xAI ${res.status}` };
    }
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return {
      ok: true,
      text: body.choices[0]?.message?.content?.trim() ?? "",
    };
  } catch (e) {
    return {
      ok: false,
      text: "",
      error: e instanceof Error ? e.message : "AI error",
    };
  }
}
