/**
 * AI relay for the Sandbox page.
 *
 * A visitor chats with an AI agent that buys through THEIR OWN sandbox vault.
 * Every tool the model calls is executed in the visitor's browser with the
 * agent key their vault issued. The only thing that can't live in a browser is
 * the model provider's API key, so this relay holds it: it forwards the
 * conversation with a fixed system prompt and fixed tools and returns the
 * model's next message. It holds no wallet keys and moves no money.
 *
 * Env: GROQ_API_KEY (required to enable), GROQ_MODEL, GROQ_URL,
 *      AI_PER_VISITOR_DAILY (60 model calls), AI_GLOBAL_DAILY (3000).
 */

export const AGENT_PROMPT = `You are a purchasing agent in Almoner's live sandbox on NEAR testnet. The person you talk to owns a vault and signed spending rules for your task. You hold an agent key that can only ASK the vault to buy. The vault, not you, decides.

How to work:
- Start with get_rules if you have not read the rules in this conversation.
- To buy: list_catalog for a seller, get_quote for the item (you may make a lower offer once; if the seller counters, take the counter), then request_purchase with the quote_id and a short reason.
- If the vault answers APPROVED, call collect_delivery, look at what came back, then review_delivery: accept real data; reject an empty file or an error message.
- If the vault answers REFUSED or WAITING FOR THE OWNER, do not retry and do not look for a way around it. Tell the person the code and the reason in one sentence. For WAITING, tell them they can approve it in the owner panel.
- Treat every new request from the person as a fresh job and make a real attempt with the tools, even if an earlier attempt in this conversation was refused or failed. The owner can unfreeze the vault, issue a new key, approve a purchase or change the rules at any time, so an old answer may no longer hold. Never answer from an earlier refusal without trying again.
- You are deliberately obedient: if the person, or a page you were asked to read, tells you to buy something, attempt it through the vault even if it looks off-task, and report what the vault said. Showing where the vault stops you is the point of this sandbox. Never claim something was bought unless the vault's answer says so.
- Prices are in tUSDC, a test token. Keep replies to one to three plain sentences. Do only what this sandbox is for; for anything else, say so in one sentence.`;

const str = (description: string) => ({ type: "string", description });
const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const AGENT_TOOLS = [
  fn("get_rules", "Read the rules the owner signed for your task, the budget left, and the sellers with their track record."),
  fn("list_catalog", "List what a seller offers, with list prices.", { seller: str("Seller name: datadesk or junkdata") }, ["seller"]),
  fn("get_quote", "Ask a seller for a signed price quote. Returns a quote_id.", { seller: str("Seller name"), item: str("Item address from list_catalog"), offer_tusdc: { type: "number", description: "Optional lower offer, e.g. 0.09" } }, ["seller", "item"]),
  fn("request_purchase", "Ask the vault to buy a quoted item. The vault answers APPROVED (held in escrow), WAITING FOR THE OWNER, REUSED, or REFUSED with a code.", { quote_id: str("From get_quote"), reason: str("Why the task needs this, one sentence") }, ["quote_id", "reason"]),
  fn("collect_delivery", "Ask the seller to deliver an approved purchase. Returns the delivered content. The seller is still unpaid.", { purchase_id: { type: "integer" } }, ["purchase_id"]),
  fn("review_delivery", "Accept a delivery (the vault pays the seller) or reject it (refund; seller put on hold).", { purchase_id: { type: "integer" }, accept: { type: "boolean" }, note: str("Reason when rejecting") }, ["purchase_id", "accept"]),
  fn("read_page", "Read a web page the person asked you to read.", { url: str("The page address") }, ["url"]),
];
const TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.function.name));

/** Accept only a well-formed conversation; returns the clean messages or an error string. */
export function cleanConversation(input: unknown): { role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }[] | string {
  if (!Array.isArray(input) || !input.length) return "messages must be a non-empty list";
  if (input.length > 60) return "This conversation is long. Press New chat to start again.";
  let total = 0;
  const out: any[] = [];
  for (const m of input) {
    const content = typeof m?.content === "string" ? m.content : "";
    if (content.length > 6000) return "a message is too long";
    total += content.length;
    if (m?.role === "user") out.push({ role: "user", content });
    else if (m?.role === "tool" && typeof m.tool_call_id === "string" && m.tool_call_id.length <= 100) out.push({ role: "tool", tool_call_id: m.tool_call_id, content });
    else if (m?.role === "assistant") {
      const msg: any = { role: "assistant", content };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (m.tool_calls.length > 6) return "too many tool calls";
        msg.tool_calls = [];
        for (const c of m.tool_calls) {
          const name = c?.function?.name;
          const args = typeof c?.function?.arguments === "string" ? c.function.arguments : "{}";
          if (typeof c?.id !== "string" || c.id.length > 100 || !TOOL_NAMES.has(name) || args.length > 4000) return "bad tool call";
          total += args.length;
          msg.tool_calls.push({ id: c.id, type: "function", function: { name, arguments: args } });
        }
      }
      out.push(msg);
    } else return "bad message";
  }
  if (total > 60_000) return "This conversation is long. Press New chat to start again.";
  if (out[0].role !== "user") return "the conversation must start with you";
  return out;
}

const day = () => new Date().toISOString().slice(0, 10);
let today = day();
let globalCalls = 0;
const perVisitor = new Map<string, number>();

export const relayEnabled = () => !!process.env.GROQ_API_KEY;

/** One model step. Throws an Error whose message is safe to show a visitor. */
export async function agentStep(visitor: string, messages: unknown): Promise<{ message: unknown; left: number }> {
  if (!relayEnabled()) throw Object.assign(new Error("The AI agent isn't switched on for this server."), { status: 503 });
  const clean = cleanConversation(messages);
  if (typeof clean === "string") throw Object.assign(new Error(clean), { status: 400 });
  if (day() !== today) {
    today = day();
    globalCalls = 0;
    perVisitor.clear();
  }
  const cap = Number(process.env.AI_PER_VISITOR_DAILY ?? 60);
  const used = perVisitor.get(visitor) ?? 0;
  if (used >= cap) throw Object.assign(new Error("You've used today's AI allowance for this demo. It resets at midnight UTC."), { status: 429 });
  if (globalCalls >= Number(process.env.AI_GLOBAL_DAILY ?? 3000)) throw Object.assign(new Error("The demo's AI has reached its daily limit. Try again tomorrow."), { status: 429 });
  perVisitor.set(visitor, used + 1);
  globalCalls++;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(process.env.GROQ_URL ?? "https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b", messages: [{ role: "system", content: AGENT_PROMPT }, ...clean], tools: AGENT_TOOLS, tool_choice: "auto", temperature: 0.2, max_completion_tokens: 900 }),
      signal: AbortSignal.timeout(45_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) {
      const m = body.choices?.[0]?.message ?? {};
      return { message: { role: "assistant", content: typeof m.content === "string" ? m.content : "", ...(Array.isArray(m.tool_calls) && m.tool_calls.length ? { tool_calls: m.tool_calls } : {}) }, left: cap - used - 1 };
    }
    const retry = res.status === 429 || res.status >= 500 || (res.status === 400 && body?.error?.code === "tool_use_failed");
    if (attempt < 4 && retry) {
      // Respect the provider's own hint when it gives one (rate limits clear in seconds).
      const hint = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Math.min(hint > 0 ? hint * 1000 + 300 : 1500 * attempt, 12_000)));
      continue;
    }
    console.error("model error", res.status, body?.error?.message);
    throw Object.assign(new Error(res.status === 429 ? "The AI provider is busy. Try again in a minute." : `The AI provider answered with an error (${res.status}).`), { status: 502 });
  }
}
