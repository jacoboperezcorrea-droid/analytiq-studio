// Veo con fotos de referencia del personaje ("Ingredients to Video"): la misma cara en todas las escenas.
// Auth: x-cron-secret. Body: { slug, step, prompt, refs: [url, url, url], model?, aspect?, resolution?, negative? }
// Registra la toma en ugc_generations (provider gemini); la descarga la hace ugc-studio con action veo_status.
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const API = "https://generativelanguage.googleapis.com/v1beta";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
async function secret(fn: string, name: string) { const { data } = await sb.rpc(fn, { p_name: name }); return data as string | null; }

async function ref(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("No pude bajar referencia " + url);
  return { image: { bytesBase64Encoded: encodeBase64(new Uint8Array(await r.arrayBuffer())), mimeType: r.headers.get("content-type") || "image/jpeg" }, referenceType: "asset" };
}

Deno.serve(async (req) => {
  try {
    const cron = req.headers.get("x-cron-secret");
    if (!cron || cron !== (await secret("com_get_secret", "hallazgo_cron_secret"))) return json({ error: "unauthorized" }, 401);
    const b = await req.json();
    const key = await secret("com_get_secret", "hallazgo_gemini_key");
    if (!key) throw new Error("No hay llave de Gemini");
    const model = b.model || "veo-3.1-generate-preview";
    if (model.includes("lite")) throw new Error("lite no soporta referencias");
    const resolution = b.resolution || "720p";
    const refs = await Promise.all((b.refs || []).slice(0, 3).map(ref));
    const instance: any = { prompt: b.prompt };
    if (refs.length) instance.referenceImages = refs;
    const parameters: any = { aspectRatio: b.aspect || "16:9", resolution, durationSeconds: 8, personGeneration: "allow_adult" };
    if (b.negative) parameters.negativePrompt = b.negative;
    const r = await fetch(`${API}/models/${model}:predictLongRunning`, {
      method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ instances: [instance], parameters }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error("Veo: " + (j.error?.message || r.status));
    const { data, error } = await sb.from("ugc_generations").insert({
      model_slug: b.slug || null, step: b.step || "veo_ref", quality: "final", provider: "gemini", ai_model: `${model}@${resolution}`,
      kind: "video", units: 8, cost_usd: 0, ok: false, status: "procesando", external_id: j.name,
      meta: { refs: b.refs, parameters }, prompt: b.prompt,
    }).select("id").single();
    if (error) throw new Error("registro: " + error.message);
    return json({ ok: true, generation_id: data.id, operation: j.name });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
