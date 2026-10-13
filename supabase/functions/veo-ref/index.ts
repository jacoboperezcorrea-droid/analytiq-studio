// Veo con fotos de referencia del personaje ("Ingredients to Video"): la misma cara en todas las escenas.
// Auth: x-cron-secret. Body: { slug, step, prompt, refs: [url, url, url], model?, aspect?, provider?: "fal" | "gemini" }
// Proveedor por defecto: fal.ai (mismo Veo 3.1, mismo precio, sin tope diario; solo limite de tomas en paralelo).
// Veo Fast va por Gemini (fal no tiene version rapida con referencias). La descarga la hace ugc-studio con action veo_status.
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
    const model = b.model || "veo-3.1-generate-preview";
    const provider = model.includes("fast") ? "gemini" : (b.provider || "fal");
    if (provider === "fal") {
      const fk = await secret("ugc_get_secret", "ugc_fal_key");
      if (!fk) throw new Error("No hay ugc_fal_key");
      const FAL = "fal-ai/veo3.1/reference-to-video";
      const r = await fetch(`https://queue.fal.run/${FAL}`, {
        method: "POST", headers: { Authorization: `Key ${fk}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: b.prompt, image_urls: (b.refs || []).slice(0, 3), aspect_ratio: b.aspect || "16:9", duration: "8s", resolution: "1080p", generate_audio: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = JSON.stringify(j.detail || j).slice(0, 300);
        if (/balance|exhausted|locked|insufficient/i.test(msg)) throw new Error("fal.ai sin saldo (credits): recargar en fal.ai/dashboard/billing");
        throw new Error("fal Veo: " + msg);
      }
      const { data, error } = await sb.from("ugc_generations").insert({
        model_slug: b.slug || null, step: b.step || "veo_ref", quality: "final", provider: "fal", ai_model: `${FAL}@1080p`,
        kind: "video", units: 8, cost_usd: 0, ok: false, status: "procesando", external_id: j.request_id,
        meta: { status_url: j.status_url, response_url: j.response_url, refs: b.refs, num_frames: 0 }, prompt: b.prompt,
      }).select("id").single();
      if (error) throw new Error("registro: " + error.message);
      return json({ ok: true, generation_id: data.id, operation: j.request_id, via: "fal" });
    }
    const key = await secret("com_get_secret", "hallazgo_gemini_key");
    if (!key) throw new Error("No hay llave de Gemini");
    if (model.includes("lite")) throw new Error("lite no soporta referencias");
    // 1080p siempre: el recorte cuadrado queda nativo (1080x1080) sin estirar; en Veo normal cuesta igual que 720p
    const resolution = "1080p";
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
