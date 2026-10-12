// Estudio UGC por roles: procesa los pedidos que llegan con el brief del formulario de la Torre (status "estudio").
//   estudio -> 7 agentes de Claude (ejecutiva, director, guionista, coach de acento, arte, vestuario, actores)
//   -> camarografa: tomas de Veo con fotos de referencia de la modelo (veo-ref) -> status estudio_tomas
//   -> editor: spec cuadrado tipo cine + musica, render en GitHub Actions -> status estudio_edicion
//   -> aprobacion en la Torre (por_aprobar). La aprobacion y el paso a redes los sigue haciendo ugc-director.
// Acciones: tick (por defecto). Auth: x-cron-secret = hallazgo_cron_secret
import { createClient } from "npm:@supabase/supabase-js@2";
import { ROLES, takesFor, veoModelFor, takePrompt, buildBriefSpec } from "./estudio.ts";

const AQ = "c6e4b4ac-8904-458e-aa70-a8b348269fe9";
const HZ = "dbd5de2f-ca0d-47cb-b5cb-92b3c74fdf6f";
const NEGOCIO: Record<string, string> = { [AQ]: "AnalytiQ Core", [HZ]: "Hallazgo" };
const BASE = Deno.env.get("SUPABASE_URL")!;
const MODEL = "claude-sonnet-5-5";
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function hsecret(n: string) { const { data } = await sb.rpc("com_get_secret", { p_name: n }); return data as string | null; }
async function asecret(n: string) { const { data } = await sb.rpc("analytiq_get_secret", { p_name: n }); return data as string | null; }
async function setReq(id: string, f: Record<string, unknown>) {
  await sb.from("ugc_requests").update({ ...f, updated_at: new Date().toISOString() }).eq("id", id);
}
async function fn(name: string, body: unknown) {
  const r = await fetch(`${BASE}/functions/v1/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": (await hsecret("hallazgo_cron_secret"))! }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${name}: ${j.error || r.status}`);
  return j;
}

// Un agente: Claude por API, respuesta por herramienta para que el JSON llegue valido
async function agente(system: string, user: string, req: any, step: string) {
  const key = (await asecret("analytiq_anthropic_key")) || (await hsecret("hallazgo_anthropic_key"));
  if (!key) throw new Error("No hay llave de Claude Console en el Vault");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, system, messages: [{ role: "user", content: user }],
      tools: [{ name: "entregar", description: "Entrega tu trabajo con la estructura JSON pedida en las instrucciones.", input_schema: { type: "object", additionalProperties: true } }],
      tool_choice: { type: "auto" } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude API: " + (j.error?.message || r.status));
  const tool = (j.content || []).find((c: any) => c.type === "tool_use");
  let raw = tool?.input ? JSON.stringify(tool.input) : null;
  if (!raw) {
    const txt = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("El agente " + step + " no entrego su trabajo");
    raw = txt.slice(a, b + 1);
  }
  const u = j.usage || {};
  const cost = ((u.input_tokens || 0) * 2 + (u.output_tokens || 0) * 10) / 1e6;
  await sb.from("ugc_generations").insert({ order_id: req.order_id, model_slug: req.model_slug, step, quality: "final", provider: "anthropic",
    ai_model: MODEL, kind: "text", units: 1, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: Number(cost.toFixed(4)), ok: true, prompt: user.slice(0, 4000) });
  const out = JSON.parse(raw.split("—").join(". ").split("–").join(". "));
  // A veces un agente devuelve una lista como texto (y con un cierre de mas): se convierte a lista de verdad
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!(t.startsWith("[") || t.startsWith("{"))) continue;
    const end = t.lastIndexOf(t.startsWith("[") ? "]" : "}");
    for (const cand of [t, t.slice(0, end + 1)]) { try { out[k] = JSON.parse(cand); break; } catch (_) { /* sigue */ } }
  }
  return out;
}

async function stepEstudio(req: any) {
  const { data: model } = await sb.from("ugc_models").select("*").eq("slug", req.model_slug).single();
  if (!model) throw new Error("No existe la modelo " + req.model_slug);
  if (!req.order_id) {
    const { data: o } = await sb.from("ugc_orders").insert({ model_slug: req.model_slug, title: `${NEGOCIO[req.tenant_id] || ""}: ${req.product_name}`, format: `ugc_${req.duration}s`, price_cop: 0, status: "en_produccion" }).select("id").single();
    req.order_id = o!.id;
    await setReq(req.id, { order_id: req.order_id });
  }
  const b = req.brief || {};
  const n = takesFor(req);
  const script = req.script?.roles ? req.script : { roles: {}, tomas: [] as any[] };
  const prod = `${req.product_name}. ${req.product_info || ""}`.trim();
  const val = (k: string) => { const v = b[k]; return Array.isArray(v) ? v.map((x) => String(x).split("_").join(" ")).join(", ") : v === true ? "si" : v === false ? "no" : String(v ?? "").split("_").join(" "); };
  const ctx = {
    b, m: model, n, prod, r: script.roles,
    base: `Negocio: ${b.negocio || NEGOCIO[req.tenant_id] || "la marca"}. Producto o servicio: ${prod}. Modelo: ${model.name}, ${model.age} anos, de ${model.city}. Personalidad base: ${model.personality || ""}.`,
    bloque: (ks: string[]) => ks.filter((k) => val(k)).map((k) => `- ${k.split("_").join(" ")}: ${val(k)}`).join(String.fromCharCode(10)) || "- (sin datos, usa tu criterio)",
    label: (k: string) => val(k),
  };
  // Fase 1: los agentes, en orden y de a dos por ronda para no pasar el tiempo limite de la funcion
  let hechos = 0;
  for (const role of ROLES) {
    if (script.roles[role.key]) continue;
    if (hechos >= 2) return { id: req.id, fase: "roles", siguiente: role.key };
    script.roles[role.key] = await agente(role.system + " Entrega tu trabajo llamando la herramienta entregar. Dentro de los textos no uses comillas dobles.", role.input(ctx), req, "rol_" + role.key);
    await setReq(req.id, { script, error: null });
    hechos++;
  }
  // Fase 2: la camarografa arma cada toma y la graba en Veo con las fotos de referencia de la modelo
  if (!script.tomas.length) {
    script.tomas = Array.from({ length: n }, (_, i) => ({ prompt: takePrompt(script.roles, i) }));
    script.caption = script.roles.guionista?.caption || "";
    script.music_prompt = script.roles.director?.musica_prompt || "";
    await setReq(req.id, { script });
  }
  const refs = (model.ref_photos?.length ? model.ref_photos : [model.photos?.para_animar, model.photos?.frente_sonrisa, model.photos?.cuerpo_entero]).filter(Boolean).slice(0, 3);
  if (!refs.length) throw new Error("La modelo no tiene fotos de referencia");
  let arrancadas = 0;
  for (let i = 0; i < script.tomas.length; i++) {
    const tk = script.tomas[i];
    if (tk.gen) continue;
    if (arrancadas) await sleep(15000);
    try {
      const r = await fn("veo-ref", { slug: req.model_slug, step: `pedido_${req.id.slice(0, 8)}_t${i + 1}`, model: veoModelFor(req), aspect: b.encuadre === "vertical" ? "9:16" : "16:9", resolution: "720p", refs, prompt: tk.prompt });
      tk.gen = r.generation_id; arrancadas++;
      await setReq(req.id, { script });
    } catch (err) {
      const msg = String((err as Error).message || err);
      if (/quota|exceeded|rate|RESOURCE_EXHAUSTED|high demand|prepayment|credits/i.test(msg)) {
        await setReq(req.id, { script, error: /prepayment|credits/i.test(msg) ? "Sin saldo en Google (recargar en AI Studio). El pedido sigue solo cuando haya saldo." : `Veo pidio esperar: ${i} de ${script.tomas.length} tomas iniciadas` });
        return { id: req.id, fase: "tomas", iniciadas: i };
      }
      throw err;
    }
  }
  await setReq(req.id, { clip_ids: script.tomas.map((t: any) => t.gen), status: "estudio_tomas", error: null });
  return { id: req.id, status: "estudio_tomas" };
}

async function stepTomas(req: any) {
  const urls: string[] = [];
  for (const [ci, gid] of (req.clip_ids || []).entries()) {
    const s = (await fn("ugc-studio", { action: "veo_status", generation_id: gid })).result;
    if (s.status === "error") {
      const script = req.script;
      if ((script.tomas[ci].fallos || 0) >= 2) throw new Error(`La toma ${ci + 1} fallo 3 veces: ${String(s.error || "").slice(0, 200)}`);
      // Si Veo bloquea una toma, se repite solo esa y lo demas se conserva
      script.tomas[ci].fallos = (script.tomas[ci].fallos || 0) + 1;
      delete script.tomas[ci].gen;
      await setReq(req.id, { script, status: "estudio", clip_ids: [], error: `Repitiendo toma ${ci + 1}: ${String(s.error || "").slice(0, 200)}` });
      return { id: req.id, repite: ci + 1 };
    }
    if (s.status !== "listo") return { id: req.id, waiting: true };
    urls.push(s.url);
  }
  const { data: model } = await sb.from("ugc_models").select("*").eq("slug", req.model_slug).single();
  const spec = buildBriefSpec(req, req.script, urls, model);
  let music: string | null = null;
  if ((req.edit || {}).musica !== false) {
    try { music = (await fn("analytiq-studio", { action: "music", slug: `ugc-${req.id.slice(0, 8)}`, prompt: req.script.music_prompt || "Cinematic suspense instrumental with a tense intro, a hit and a driving rhythm, no vocals, 30 seconds." })).result.url; }
    catch (_) { music = null; }
  }
  const { data: job, error } = await sb.from("analytiq_content_jobs").insert({
    tenant_id: req.tenant_id, kind: "reel", title: spec.title, caption: req.script.caption, spec, music_url: music, status: "rendering",
  }).select("id").single();
  if (error) throw new Error("job: " + error.message);
  const token = await asecret("analytiq_github_token");
  const r = await fetch("https://api.github.com/repos/jacoboperezcorrea-droid/analytiq-studio/actions/workflows/render.yml/dispatches", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ugc-estudio", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "main", inputs: { job_id: job!.id } }),
  });
  if (r.status !== 204) throw new Error(`GitHub ${r.status}`);
  await setReq(req.id, { job_id: job!.id, status: "estudio_edicion" });
  return { id: req.id, status: "estudio_edicion", job: job!.id };
}

async function stepEdicion(req: any) {
  const { data: job } = await sb.from("analytiq_content_jobs").select("status,files,approval_id,error").eq("id", req.job_id).single();
  if (!job) throw new Error("No existe el trabajo de edicion");
  if (job.status === "error") throw new Error("La edicion fallo: " + (job.error || ""));
  if (job.status !== "pending_approval" || !job.approval_id) return { id: req.id, waiting: true };
  const video = (job.files || []).find((f: string) => f.endsWith(".mp4")) || null;
  const cover = (job.files || []).find((f: string) => f.endsWith(".png")) || null;
  const { data: ap } = await sb.from("com_approvals").select("payload").eq("id", job.approval_id).single();
  const { data: costo } = await sb.from("ugc_generations").select("cost_usd").eq("order_id", req.order_id).eq("ok", true);
  const usd = (costo || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0);
  await sb.from("com_approvals").update({
    tenant_id: req.tenant_id,
    title: `Video UGC: ${req.product_name} (${req.duration} s, ${req.model_slug})`,
    summary: `Revisa el video: ${video}`,
    payload: { ...(ap?.payload || {}), negocio: NEGOCIO[req.tenant_id], origen: "ugc", ugc_request_id: req.id, video, revisar: video, portada: cover, costo_usd: Number(usd.toFixed(2)) },
  }).eq("id", job.approval_id);
  await setReq(req.id, { status: "por_aprobar", video_url: video, cover_url: cover, approval_id: job.approval_id });
  return { id: req.id, status: "por_aprobar", video };
}

async function tick() {
  const { data: reqs } = await sb.from("ugc_requests").select("*").in("status", ["estudio", "estudio_tomas", "estudio_edicion"]).lt("attempts", 3).order("created_at").limit(3);
  const out: any[] = [];
  for (const req of reqs || []) {
    try {
      if (req.status === "estudio") out.push(await stepEstudio(req));
      else if (req.status === "estudio_tomas") out.push(await stepTomas(req));
      else out.push(await stepEdicion(req));
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 500);
      const attempts = (req.attempts || 0) + 1;
      await setReq(req.id, { attempts, error: msg, status: attempts >= 3 ? "error" : req.status });
      out.push({ id: req.id, error: msg });
    }
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-cron-secret") !== (await hsecret("hallazgo_cron_secret"))) return json({ error: "unauthorized" }, 401);
    return json({ ok: true, result: await tick() });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
