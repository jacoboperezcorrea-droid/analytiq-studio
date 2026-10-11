// Estudio de la agencia UGC de AnalytiQ Core (AnalytiQ UGC).
// Gemini (imagenes de los modelos) + ElevenLabs (voces) + fal InfiniteTalk (animacion). Registra el costo de cada generacion en ugc_generations.
// Auth: x-cron-secret. Acciones: image_models | generate | costs | voice_design | voice_save | tts | xi_account | talk_start | talk_status
// generate: { slug, step, quality: "prueba" (Flash, por defecto) | "final" (Pro), order_id?, prompts[] | prompt+n, refs[], aspect }
import { createClient } from "npm:@supabase/supabase-js@2";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";

const BUCKET = "analytiq-media";
const API = "https://generativelanguage.googleapis.com/v1beta";
const MODELS: Record<string, string> = { prueba: "gemini-3.1-flash-image", final: "gemini-3-pro-image" };
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function secret(fn: string, name: string) { const { data } = await sb.rpc(fn, { p_name: name }); return data as string | null; }
async function geminiKey() {
  const k = (await secret("analytiq_get_secret", "analytiq_gemini_key")) || (await secret("com_get_secret", "hallazgo_gemini_key"));
  if (!k) throw new Error("No hay llave de Gemini en el Vault");
  return k;
}

async function prices(model: string) {
  const { data } = await sb.from("ugc_prices").select("unit,usd_per_unit").eq("provider", "gemini").eq("ai_model", model);
  const p: Record<string, number> = {};
  for (const r of data || []) p[r.unit] = Number(r.usd_per_unit);
  return p;
}
async function imageModels(key: string) {
  const r = await fetch(`${API}/models?pageSize=300`, { headers: { "x-goog-api-key": key } });
  const j = await r.json();
  if (!r.ok) throw new Error("Gemini models: " + (j.error?.message || r.status));
  return (j.models || []).filter((m: any) => /image|imagen/i.test(m.name)).map((m: any) => m.name);
}
async function refPart(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("No pude bajar referencia " + url);
  const mime = r.headers.get("content-type") || "image/png";
  return { inlineData: { mimeType: mime, data: encodeBase64(new Uint8Array(await r.arrayBuffer())) } };
}
async function generateOne(key: string, model: string, prompt: string, refs: any[], aspect: string, path: string) {
  const body = { contents: [{ role: "user", parts: [...refs, { text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } } };
  const r = await fetch(`${API}/models/${model}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  const usage = { input: j.usageMetadata?.promptTokenCount || 0, output: j.usageMetadata?.candidatesTokenCount || 0 };
  if (!r.ok) return { error: "Gemini: " + (j.error?.message || r.status), usage, billed: false };
  const part = (j.candidates?.[0]?.content?.parts || []).find((p: any) => p.inlineData || p.inline_data);
  const data = part?.inlineData?.data || part?.inline_data?.data;
  if (!data) return { error: "Sin imagen: " + JSON.stringify(j.candidates?.[0]?.finishReason || j.promptFeedback || {}).slice(0, 200), usage, billed: usage.input > 0 };
  const mime = part.inlineData?.mimeType || part.inline_data?.mime_type || "image/png";
  const file = path + (mime.includes("jpeg") ? ".jpg" : ".png");
  const up = await sb.storage.from(BUCKET).upload(file, decodeBase64(data), { contentType: mime, upsert: true });
  if (up.error) return { error: "storage: " + up.error.message, usage, billed: true, image: true };
  return { url: sb.storage.from(BUCKET).getPublicUrl(file).data.publicUrl, usage, billed: true, image: true };
}
async function generate(key: string, b: any) {
  const quality = b.quality === "final" ? "final" : "prueba";
  const model = b.model || MODELS[quality];
  const p = await prices(model);
  const refs = await Promise.all((b.refs || []).map(refPart));
  const n = Math.min(Number(b.n || 1), 6);
  const slug = (b.slug || "modelo").replace(/[^a-z0-9_-]/gi, "_");
  const step = b.step || "base";
  const stamp = Date.now();
  const prompts: string[] = Array.isArray(b.prompts) ? b.prompts : Array(n).fill(b.prompt);
  const out = await Promise.all(prompts.map((pr, i) => generateOne(key, model, pr, refs, b.aspect || "9:16", `ugc/modelos/${slug}/${step}_${stamp}_${i + 1}`)));
  const rows = out.map((o: any, i) => {
    const cost = (o.image ? (p.image || 0) : 0) + (o.billed ? (o.usage.input / 1e6) * (p["1m_input_tokens"] || 0) : 0);
    return { order_id: b.order_id || null, model_slug: slug, step, quality, provider: "gemini", ai_model: model, kind: "image",
      units: o.image ? 1 : 0, input_tokens: o.usage.input, output_tokens: o.usage.output, cost_usd: Number(cost.toFixed(4)),
      ok: !!o.url, url: o.url || null, error: o.error || null, prompt: prompts[i].slice(0, 4000) };
  });
  const ins = await sb.from("ugc_generations").insert(rows);
  if (ins.error) await sb.from("ugc_generations").insert(rows.map((r) => ({ ...r, model_slug: null, step: `${slug}/${step}` })));
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  return { model, quality, cost_usd: Number(total.toFixed(4)), images: out.map((o: any) => (o.url ? { url: o.url } : { error: o.error })) };
}
async function costs() {
  const [m, o] = await Promise.all([sb.from("ugc_model_setup_cost").select("*"), sb.from("ugc_order_profit").select("*").order("id")]);
  return { modelos: m.data, pedidos: o.data };
}

// ---------- ElevenLabs (voz) ----------
const XI = "https://api.elevenlabs.io/v1";
async function xiKey() {
  const k = await secret("ugc_get_secret", "ugc_elevenlabs_key");
  if (!k) throw new Error("No hay ugc_elevenlabs_key en el Vault");
  return k;
}
async function xiPrice() {
  const { data } = await sb.from("ugc_prices").select("usd_per_unit").eq("provider", "elevenlabs").eq("ai_model", "tts").eq("unit", "1k_chars").maybeSingle();
  return Number(data?.usd_per_unit || 0);
}
async function logVoice(row: Record<string, unknown>) {
  const ins = await sb.from("ugc_generations").insert(row);
  if (ins.error) await sb.from("ugc_generations").insert({ ...row, model_slug: null });
}

async function voiceDesign(b: any) {
  const key = await xiKey();
  const slug = (b.slug || "modelo").replace(/[^a-z0-9_-]/gi, "_");
  const body: any = { voice_description: b.description, model_id: b.model || "eleven_ttv_v3", text: b.text, guidance_scale: b.guidance ?? 5 };
  if (!b.text) body.auto_generate_text = true;
  if (b.seed != null) body.seed = b.seed;
  const r = await fetch(`${XI}/text-to-voice/design?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("ElevenLabs design: " + JSON.stringify(j.detail || j).slice(0, 300));
  const stamp = Date.now();
  const out: any[] = [];
  for (let i = 0; i < (j.previews || []).length; i++) {
    const p = j.previews[i];
    const file = `ugc/modelos/${slug}/voz_${stamp}_${i + 1}.mp3`;
    const up = await sb.storage.from(BUCKET).upload(file, decodeBase64(p.audio_base_64), { contentType: p.media_type || "audio/mpeg", upsert: true });
    out.push({ opcion: i + 1, generated_voice_id: p.generated_voice_id, duracion: p.duration_secs, url: up.error ? null : sb.storage.from(BUCKET).getPublicUrl(file).data.publicUrl });
  }
  const chars = (j.text || b.text || "").length;
  await logVoice({ model_slug: slug, step: "voz_diseno", quality: "prueba", provider: "elevenlabs", ai_model: body.model_id, kind: "audio",
    units: chars, cost_usd: Number(((chars / 1000) * (await xiPrice())).toFixed(4)), ok: out.length > 0, url: out[0]?.url || null, prompt: b.description });
  return { texto: j.text, opciones: out };
}

async function voiceSave(b: any) {
  const key = await xiKey();
  const r = await fetch(`${XI}/text-to-voice`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ voice_name: b.name, voice_description: b.description, generated_voice_id: b.generated_voice_id }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("ElevenLabs save: " + JSON.stringify(j.detail || j).slice(0, 300));
  if (b.slug) await sb.from("ugc_models").update({ voice_id: j.voice_id, updated_at: new Date().toISOString() }).eq("slug", b.slug);
  return { voice_id: j.voice_id };
}

async function tts(b: any) {
  const key = await xiKey();
  let voice = b.voice_id;
  if (!voice && b.slug) { const { data } = await sb.from("ugc_models").select("voice_id").eq("slug", b.slug).single(); voice = data?.voice_id; }
  if (!voice) throw new Error("El modelo no tiene voz guardada");
  const r = await fetch(`${XI}/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text: b.text, model_id: b.model || "eleven_v3" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("ElevenLabs tts: " + JSON.stringify(j.detail || j).slice(0, 300));
  const file = `ugc/audios/${b.slug || "voz"}_${Date.now()}.mp3`;
  await sb.storage.from(BUCKET).upload(file, decodeBase64(j.audio_base64), { contentType: "audio/mpeg", upsert: true });
  const url = sb.storage.from(BUCKET).getPublicUrl(file).data.publicUrl;
  await logVoice({ order_id: b.order_id || null, model_slug: b.slug || null, step: b.step || "audio", quality: "final", provider: "elevenlabs", ai_model: b.model || "eleven_v3",
    kind: "audio", units: b.text.length, cost_usd: Number(((b.text.length / 1000) * (await xiPrice())).toFixed(4)), ok: true, url, prompt: b.text });
  return { url, alignment: j.alignment };
}

async function xiAccount() {
  const key = await xiKey();
  const r = await fetch(`${XI}/user/subscription`, { headers: { "xi-api-key": key } });
  const j = await r.json();
  if (!r.ok) throw new Error("ElevenLabs cuenta: " + JSON.stringify(j.detail || j).slice(0, 300));
  return { plan: j.tier, usados: j.character_count, limite: j.character_limit, renueva: j.next_character_count_reset_unix };
}

// ---------- fal.ai (InfiniteTalk: poner a hablar al modelo) ----------
const FAL_MODEL = "fal-ai/infinitalk";
async function falKey() {
  const k = await secret("ugc_get_secret", "ugc_fal_key");
  if (!k) throw new Error("No hay ugc_fal_key en el Vault");
  return k;
}
const TALK_PROMPT = "A young woman talking naturally to her phone's front camera like recording an Instagram story, subtle natural head movements, natural blinking, relaxed shoulders, expressive eyebrows, realistic, handheld smartphone feel.";

async function talkStart(b: any) {
  const key = await falKey();
  let image = b.image_url;
  if (!image && b.slug) { const { data } = await sb.from("ugc_models").select("photos").eq("slug", b.slug).single(); image = data?.photos?.para_animar; }
  if (!image) throw new Error("Falta la foto para animar");
  if (!b.audio_url) throw new Error("Falta audio_url");
  const secs = Number(b.seconds || 6);
  const resolution = b.resolution === "720p" ? "720p" : "480p";
  // InfiniteTalk usa 25 fps y cuadros 4n+1; fal exige audio >= cuadros/25
  const num_frames = Math.max(41, Math.min(721, Math.floor((secs * 25 - 1) / 4) * 4 + 1));
  const r = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: "POST", headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: image, audio_url: b.audio_url, prompt: b.prompt || TALK_PROMPT, num_frames, resolution, acceleration: b.acceleration || "regular" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("fal: " + JSON.stringify(j.detail || j).slice(0, 300));
  const { data, error } = await sb.from("ugc_generations").insert({
    order_id: b.order_id || null, model_slug: b.slug || null, step: b.step || "habla", quality: resolution === "720p" ? "final" : "prueba",
    provider: "fal", ai_model: `${FAL_MODEL}@${resolution}`, kind: "video", units: secs, cost_usd: 0, ok: false, status: "procesando",
    external_id: j.request_id, meta: { status_url: j.status_url, response_url: j.response_url, image, audio_url: b.audio_url, num_frames }, prompt: b.prompt || TALK_PROMPT,
  }).select("id").single();
  if (error) throw new Error("registro: " + error.message);
  return { generation_id: data.id, request_id: j.request_id, frames: num_frames, resolution };
}

async function talkStatus(b: any) {
  const key = await falKey();
  const { data: g } = await sb.from("ugc_generations").select("*").eq("id", b.generation_id).single();
  if (!g) throw new Error("No existe esa generacion");
  if (g.status === "listo") return { status: "listo", url: g.url, cost_usd: g.cost_usd };
  const s = await fetch(g.meta.status_url, { headers: { Authorization: `Key ${key}` } });
  const sj = await s.json();
  if (sj.status !== "COMPLETED") return { status: sj.status, queue_position: sj.queue_position };
  const rr = await fetch(g.meta.response_url, { headers: { Authorization: `Key ${key}` } });
  const rj = await rr.json();
  const vurl = rj.video?.url;
  if (!vurl) {
    await sb.from("ugc_generations").update({ status: "error", error: JSON.stringify(rj).slice(0, 400) }).eq("id", g.id);
    return { status: "error", detail: rj };
  }
  const v = await fetch(vurl);
  const file = `ugc/videos/${g.model_slug || "modelo"}_${g.step}_${Date.now()}.mp4`;
  await sb.storage.from(BUCKET).upload(file, new Uint8Array(await v.arrayBuffer()), { contentType: "video/mp4", upsert: true });
  const url = sb.storage.from(BUCKET).getPublicUrl(file).data.publicUrl;
  const { data: p } = await sb.from("ugc_prices").select("usd_per_unit").eq("provider", "fal").eq("ai_model", g.ai_model).eq("unit", "second").maybeSingle();
  const secs = Math.max(Number(g.units || 0), (g.meta.num_frames || 0) / 25);
  const cost = Number((secs * Number(p?.usd_per_unit || 0)).toFixed(4));
  await sb.from("ugc_generations").update({ status: "listo", ok: true, url, cost_usd: cost, units: secs }).eq("id", g.id);
  return { status: "listo", url, cost_usd: cost };
}

Deno.serve(async (req) => {
  try {
    const cron = req.headers.get("x-cron-secret");
    if (!cron || cron !== (await secret("com_get_secret", "hallazgo_cron_secret"))) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    let result: unknown;
    if (b.action === "costs") result = await costs();
    else if (b.action === "voice_design") result = await voiceDesign(b);
    else if (b.action === "voice_save") result = await voiceSave(b);
    else if (b.action === "tts") result = await tts(b);
    else if (b.action === "talk_start") result = await talkStart(b);
    else if (b.action === "talk_status") result = await talkStatus(b);
    else if (b.action === "xi_account") result = await xiAccount();
    else if (b.action === "image_models") result = await imageModels(await geminiKey());
    else if (b.action === "generate") result = await generate(await geminiKey(), b);
    else throw new Error("accion desconocida");
    return json({ ok: true, result });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
