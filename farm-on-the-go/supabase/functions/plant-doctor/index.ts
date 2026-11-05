// Farm on the Go - plant doctor (for the online version; not used by the offline app yet).
// The app sends a plant photo, the crop and the signs the farmer ticked; Claude looks at the photo and returns a
// likely problem as JSON. The Anthropic key lives only here, as the ANTHROPIC_API_KEY secret - never in the app.
// Deploy: supabase functions deploy plant-doctor ; secrets: ANTHROPIC_API_KEY, ALLOWED_ORIGINS (comma separated).
import Anthropic from "npm:@anthropic-ai/sdk";

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "https://app.mydukago.co.ke,https://my-duka-go.github.io").split(",").map((s) => s.trim());
const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MAX_IMAGE_BYTES = 3_000_000;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "kind", "confidence", "signs", "actions", "sprays", "note"],
  properties: {
    name: { type: "string", description: "Most likely problem, or 'Healthy' or 'Not sure'" },
    kind: { type: "string", enum: ["disease", "pest", "nutrient or water problem", "healthy", "not sure"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    signs: { type: "string", description: "What in the photo points to this, in plain words" },
    actions: { type: "array", items: { type: "string" }, description: "Practical steps, cultural control first" },
    sprays: { type: "string", description: "Active ingredients (not brands) commonly registered in Kenya for this, or empty" },
    note: { type: "string", description: "Other look-alike problems and when to call an agronomist" },
  },
};

const SYSTEM = `You help smallholder farmers in Kenya identify crop problems from a phone photo.
Answer in simple English a farmer can follow. Give the single most likely problem for the named crop, and say "Not sure"
with low confidence if the photo is unclear, is not a plant, or the signs fit several problems equally.
Name active ingredients, never brand names, and remind the farmer to use a PCPB-registered product at the label rate
and keep the pre-harvest interval. Prefer cultural control and scouting before sprays. Photo checks are less reliable
than a lab test, so say when the farmer should show the plant to an agronomist or the county agricultural officer.`;

function cors(origin: string | null) {
  const ok = origin && ORIGINS.includes(origin);
  return { "Access-Control-Allow-Origin": ok ? origin! : ORIGINS[0], "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin" };
}
const json = (body: unknown, status: number, h: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const origin = req.headers.get("origin"), h = cors(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (!origin || !ORIGINS.includes(origin)) return json({ error: "Not allowed" }, 403, h);
  if (req.method !== "POST") return json({ error: "Use POST" }, 405, h);
  let body: { crop?: string; symptoms?: string[]; image?: string };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400, h); }
  const image = String(body.image || "").replace(/^data:image\/\w+;base64,/, "");
  if (!image || image.length * 0.75 > MAX_IMAGE_BYTES) return json({ error: "Send one photo under 3 MB" }, 400, h);
  const crop = String(body.crop || "unknown crop").slice(0, 60);
  const signs = (Array.isArray(body.symptoms) ? body.symptoms : []).slice(0, 12).map((s) => String(s).slice(0, 80));

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: `Crop: ${crop}\nSigns the farmer sees: ${signs.length ? signs.join("; ") : "none ticked"}\nWhat is the most likely problem and what should the farmer do?` },
        ],
      }],
    } as any);
    if (response.stop_reason === "refusal") return json({ error: "The plant doctor could not check this photo" }, 422, h);
    const text = response.content.find((b: any) => b.type === "text") as any;
    if (!text) return json({ error: "No answer - please try again" }, 502, h);
    return json(JSON.parse(text.text), 200, h);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "The plant doctor is busy - try again in a minute" }, 429, h);
    if (e instanceof Anthropic.APIError) return json({ error: "The plant doctor is unavailable right now" }, 502, h);
    return json({ error: "Something went wrong - please try again" }, 500, h);
  }
});
