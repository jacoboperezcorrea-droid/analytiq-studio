// Director de la agencia UGC (AnalytiQ UGC).
// Convierte cada pedido de la Torre de control (ugc_requests) en un video terminado:
//   nuevo -> guion con la API de Claude Console -> clips de Veo con la modelo (ugc-studio)
//   -> spec de edicion (cortes rapidos, zoom de golpe, 1.1x, textos, celular con la app o foto del producto)
//   -> render en GitHub Actions (analytiq-studio) -> aprobacion en la Torre con el link del video.
// Tambien hace de puente: una pieza aprobada en la Torre pasa al calendario de redes (AnalytiQ).
// Formato "pelicula" (edit.formato = "pelicula"): la modelo camina hacia la camara y el mundo cambia a su alrededor.
//   Claude escribe ambientes (ropa, objetos, interacciones, linea), Gemini hace la imagen de cada ambiente con la modelo,
//   Veo anima cada uno con su linea y la edicion los une con barridos rapidos y subtitulos de creadora.
// Acciones: tick (por defecto) | plan (solo guion, para probar) | bridge
// Auth: x-cron-secret = hallazgo_cron_secret
import { createClient } from "npm:@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const AQ = "c6e4b4ac-8904-458e-aa70-a8b348269fe9";
const HZ = "dbd5de2f-ca0d-47cb-b5cb-92b3c74fdf6f";
const NEGOCIO: Record<string, string> = { [AQ]: "AnalytiQ Core", [HZ]: "Hallazgo" };
const BASE = Deno.env.get("SUPABASE_URL")!;
const MODEL = "claude-sonnet-5-5";
const GH_REPO = "jacoboperezcorrea-droid/analytiq-studio";
const GH_REF = "main";
// Solo se pasan al calendario las piezas aprobadas desde que existe el puente
const BRIDGE_SINCE = "2026-10-11T18:30:00Z";
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function hsecret(n: string) { const { data } = await sb.rpc("com_get_secret", { p_name: n }); return data as string | null; }
async function asecret(n: string) { const { data } = await sb.rpc("analytiq_get_secret", { p_name: n }); return data as string | null; }

async function callFn(fn: string, body: unknown) {
  const r = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": (await hsecret("hallazgo_cron_secret"))! },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${fn}: ${j.error || r.status}`);
  return j.result;
}
async function setReq(id: string, f: Record<string, unknown>) {
  await sb.from("ugc_requests").update({ ...f, updated_at: new Date().toISOString() }).eq("id", id);
}

// ---------- Plan de cada duracion ----------
// Cada clip de Veo se acelera a 1.1x y se parte en cortes de ~2.3 s con zoom de golpe alterno.
type Cut = { start: number; dur: number };
const CUTS8: Cut[] = [{ start: 0, dur: 2.35 }, { start: 2.6, dur: 2.35 }, { start: 5.2, dur: 2.3 }];
const CUTS6: Cut[] = [{ start: 0, dur: 2.6 }, { start: 2.9, dur: 2.6 }];
const PLAN: Record<number, { clips: number[]; card: number }> = {
  10: { clips: [8], card: 3.0 },
  15: { clips: [8, 6], card: 2.8 },
  30: { clips: [8, 8, 8, 6], card: 3.8 },
};
const cutsFor = (secs: number) => (secs === 6 ? CUTS6 : CUTS8);

// Pelicula: segundos de cada ambiente (clips de Veo de 4, 6 u 8 s)
const FILM: Record<number, { clips: number[]; card: number }> = {
  10: { clips: [4, 6], card: 2.4 },
  15: { clips: [4, 6, 6], card: 2.6 },
  30: { clips: [6, 6, 6, 8, 6], card: 3.2 },
};
const isFilm = (req: any) => (req.edit || {}).formato === "pelicula";
const planFor = (req: any) => (isFilm(req) ? FILM : PLAN)[req.duration] || (isFilm(req) ? FILM[30] : PLAN[15]);

// ---------- Guion con Claude Console ----------
const SISTEMA = `Eres el director creativo de una agencia de videos UGC en Medellin. Escribes guiones para una modelo virtual (creada con IA) que habla a la camara del celular como creadora de contenido, en espanol de Colombia, muy expresiva, cercana y con energia, al estilo de un anuncio de colaboracion de creadora con marca.

Reglas:
- La modelo presenta y recomienda; NO inventes que ella compro o uso el producto ni testimonios falsos, ni cifras que no esten en la informacion del producto.
- Cada clip es una toma continua de la modelo hablando. Respeta el numero de palabras por clip (mas palabras de la cuenta se cortan).
- El primer clip arranca con un gancho fuerte en los primeros 2 segundos. El ultimo clip cierra con un llamado a la accion.
- Escribe los nombres de marca como se pronuncian en espanol dentro de "linea" (ej: "Analític Cor" para AnalytiQ Core) y bien escritos en los textos de pantalla.
- Textos de pantalla: uno por corte, maximo 5 palabras, que refuercen lo que ella dice en ese momento. "acento": true en maximo 2 textos de todo el video.
- NUNCA uses guion largo ni guion medio como pausa.

Devuelves SOLO JSON valido, sin markdown:
{"clips":[{"linea":"lo que dice textual","gesto":"gestos en ingles para el video, ej: counts on her fingers and laughs","textos":[{"texto":"...","acento":false}, ...]}],
 "cierre":{"titulo":"nombre del producto o marca, corto","subtitulo":"una linea de beneficio","palabra":"PALABRA clave en mayusculas para comentar o escribir"},
 "caption":"copy para Instagram/Facebook, 3 a 5 lineas, cierra con el llamado a la accion y 4 a 6 hashtags",
 "music_prompt":"en ingles: pista instrumental de unos 30 s acorde al producto, con ritmo, sin voces"}`;

async function claudeScript(req: any, model: any, plan: { clips: number[] }) {
  const key = (await asecret("analytiq_anthropic_key")) || (await hsecret("hallazgo_anthropic_key"));
  if (!key) throw new Error("No hay llave de Claude Console en el Vault");
  const negocio = NEGOCIO[req.tenant_id] || "la marca";
  const contacto = req.tenant_id === AQ ? "WhatsApp +57 310 219 7559" : "escribir por DM o comprar en hallazgo.shop con pago contra entrega";
  const clipsTxt = plan.clips.map((s, i) => `clip ${i + 1}: ${s} segundos, entre ${s === 8 ? "22 y 26" : "15 y 18"} palabras, ${cutsFor(s).length} textos de pantalla`).join("; ");
  const user = `Marca: ${negocio}. Contacto para el cierre: ${contacto}.
Modelo: ${model.name}, ${model.age} anos, de ${model.city}. Personalidad: ${model.personality}. Forma de hablar: ${model.speech_style}
Producto: ${req.product_name}.
Informacion del producto: ${req.product_info || "sin detalle"}
Duracion total: ${req.duration} segundos. Clips: ${clipsTxt}.
Guia del pedido: ${req.guide || "sin guia adicional, usa tu criterio para vender el producto"}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SISTEMA, messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude API: " + (j.error?.message || r.status));
  const txt = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude no devolvio JSON");
  const out = JSON.parse(m[0].replace(/\s*[—–]\s*/g, ". "));
  if (!Array.isArray(out.clips) || out.clips.length < plan.clips.length) throw new Error("Guion incompleto");
  out.clips = out.clips.slice(0, plan.clips.length);
  // Costo del guion (Sonnet: USD 2 / 10 por millon de tokens de entrada / salida)
  const u = j.usage || {};
  const cost = ((u.input_tokens || 0) * 2 + (u.output_tokens || 0) * 10) / 1e6;
  await sb.from("ugc_generations").insert({ order_id: req.order_id, model_slug: req.model_slug, step: "guion", quality: "final", provider: "anthropic",
    ai_model: MODEL, kind: "text", units: 1, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: Number(cost.toFixed(4)), ok: true, prompt: user.slice(0, 4000) });
  return out;
}

const SISTEMA_FILM = `Eres director creativo y de cine publicitario de una agencia UGC en Medellin. Disenas cortos verticales tipo pelicula de una sola toma: la modelo virtual (creada con IA) camina hacia la camara hablando sin parar y el mundo cambia a su alrededor; en cada ambiente cambia de ropa y de oficio, y cosas nuevas le aparecen solo a ella y ella interactua con ellas y con personas (ej: empieza a llover y saca una sombrilla y se sube el hoodie; en una hamburgueseria tiene el delantal del local y se toma una selfie con la hamburguesa).

Reglas:
- Espanol de Colombia, cercano, con energia de creadora de contenido. Nada de testimonios falsos ni cifras inventadas.
- El primer ambiente arranca con un GANCHO muy fuerte en los primeros 2 segundos: una frase que obligue a quedarse (curiosidad, sorpresa o contradiccion).
- El video explica el producto y como funciona (pasos simples) y termina con un llamado a la accion que sorprenda, que casi ni se lo esperen (un giro fisico o de guion en el ultimo ambiente).
- Cada ambiente dura lo indicado y su linea respeta el numero de palabras (mas palabras se cortan). Las lineas se encadenan como una sola frase continua.
- Escribe los nombres de marca como se pronuncian en espanol dentro de "linea" (ej: "Analític Cor") y bien escritos en subtitulos.
- "imagen" y "accion" van en ingles, muy concretas y visuales. La modelo siempre de frente caminando hacia la camara, plano de medio muslo hacia arriba. Una sola accion fisica por ambiente, sencilla y creible.
- Subtitulos: 1 o 2 bloques por ambiente, cada bloque de 1 a 3 lineas cortas (maximo 14 caracteres por linea) con lo esencial de lo que dice; "acento": true en la palabra clave.
- Exactamente un ambiente lleva "pasos": 3 pasos de maximo 4 palabras que explican como funciona.
- La modelo NO dice su nombre en las lineas (el motor de video bloquea nombres propios de personas).
- NUNCA uses guion largo ni guion medio como pausa.

Devuelves SOLO JSON valido, sin markdown:
{"escenas":[{"ambiente":"nombre corto","imagen":"location, time of day, light, outfit, props in hands, people around","accion":"what happens during the take: interaction, objects appearing, gestures","linea":"lo que dice textual","subtitulos":[[{"t":"LINEA 1","acento":false},{"t":"LINEA 2","acento":true}]],"pasos":["..."]}],
 "cierre":{"titulo":"marca o producto corto","subtitulo":"una linea de beneficio","palabra":"PALABRA para escribir"},
 "caption":"copy para Instagram/Facebook, 3 a 5 lineas, cierra con el llamado a la accion y 4 a 6 hashtags",
 "music_prompt":"en ingles: pista instrumental cinematografica y con ritmo, unos 30 s, sin voces"}`;

async function anthropic(system: string, user: string, req: any, step: string) {
  const key = (await asecret("analytiq_anthropic_key")) || (await hsecret("hallazgo_anthropic_key"));
  if (!key) throw new Error("No hay llave de Claude Console en el Vault");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    // La respuesta sale por una herramienta forzada: asi el JSON siempre llega valido (comillas escapadas)
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, system, messages: [{ role: "user", content: user }],
      tools: [{ name: "entregar_guion", description: "Entrega el guion con la estructura JSON pedida en las instrucciones.", input_schema: { type: "object", additionalProperties: true } }],
      tool_choice: { type: "auto" } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude API: " + (j.error?.message || r.status));
  const tool = (j.content || []).find((c: any) => c.type === "tool_use");
  let m: string[] | null = tool?.input ? [JSON.stringify(tool.input)] : null;
  if (!m) {
    const txt = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const t = txt.match(/\{[\s\S]*\}/);
    if (!t) throw new Error("Claude no devolvio el guion");
    m = [t[0]];
  }
  const u = j.usage || {};
  const cost = ((u.input_tokens || 0) * 2 + (u.output_tokens || 0) * 10) / 1e6;
  await sb.from("ugc_generations").insert({ order_id: req.order_id, model_slug: req.model_slug, step, quality: "final", provider: "anthropic",
    ai_model: MODEL, kind: "text", units: 1, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: Number(cost.toFixed(4)), ok: true, prompt: user.slice(0, 4000) });
  return JSON.parse(m[0].replace(/\s*[—–]\s*/g, ". "));
}

async function claudeFilm(req: any, model: any, plan: { clips: number[] }) {
  const negocio = NEGOCIO[req.tenant_id] || "la marca";
  const contacto = req.tenant_id === AQ ? "WhatsApp +57 310 219 7559 o DM" : "escribir por DM o comprar en hallazgo.shop con pago contra entrega";
  const words: Record<number, string> = { 4: "7 a 9", 6: "11 a 14", 8: "16 a 19" };
  const amb = plan.clips.map((s, i) => `ambiente ${i + 1}: ${s} s, ${words[s]} palabras`).join("; ");
  const user = `Marca: ${negocio}. Contacto para el cierre: ${contacto}.
Modelo: ${model.name}, ${model.age} anos, de ${model.city}. Personalidad: ${model.personality}. Forma de hablar: ${model.speech_style}
Producto: ${req.product_name}.
Informacion del producto: ${req.product_info || "sin detalle"}
Duracion total: ${req.duration} segundos. ${plan.clips.length} ambientes: ${amb}.
Guia del pedido: ${req.guide || "sin guia adicional, usa tu criterio"}`;
  const out = await anthropic(SISTEMA_FILM + "\n\nEntrega el guion llamando la herramienta entregar_guion (no lo escribas como texto). Dentro de los textos no uses comillas dobles.", user, req, "guion_pelicula");
  if (!Array.isArray(out.escenas) || out.escenas.length < plan.clips.length) throw new Error("Guion de pelicula incompleto");
  out.escenas = out.escenas.slice(0, plan.clips.length);
  out.formato = "pelicula";
  return out;
}

function filmImagePrompt(e: any) {
  return `Use the woman in the reference photos as the exact same person: same face, same glam makeup, same long straight dark hair, same curvy figure with full bust and wide hips. Vertical 9:16 cinematic frame shot on an iPhone by someone walking backwards in front of her: she walks TOWARD the camera, framed from mid-thigh up, centered, mouth slightly open as if starting to talk, warm expressive smile. Natural cinematic light, shallow depth of field, slight phone-lens softness and grain, real skin texture, no text, no logos, photorealistic, not AI-looking. Scene: ${e.imagen}`;
}
function filmVeoPrompt(e: any) {
  return `Vertical cinematic UGC video, one continuous handheld take: the camera operator walks backwards while the young Colombian woman in the image walks toward the camera talking to it. She starts speaking immediately from the first frame, energetic and expressive, in Spanish with a warm Medellín paisa accent, young female voice. She says: "${e.linea}" During the take: ${e.accion}. Natural hand gestures, real people and ambient sound around her, cinematic natural light. No music, no subtitles, no text on screen.`;
}

function veoPrompt(model: any, linea: string, gesto: string) {
  return `Vertical selfie video recorded on a phone propped in front of her. The young Colombian woman in the image talks to the camera like a bubbly influencer recording an Instagram story. She starts speaking immediately from the first frame and talks fast with no pauses, very energetic and expressive, in Spanish with a warm Medellín paisa accent, young female voice. She says: "${linea}" While talking she gestures a lot with both hands, ${gesto || "uses her hands to explain"}, raises her eyebrows, smiles and moves her head naturally. Natural real-life UGC look, slight handheld feel, natural room sound, no music, no subtitles, no text on screen.`;
}
const NEG = "subtitles, captions, on-screen text, watermark, music, distorted hands, extra fingers, morphing face, slow motion, long pauses, silence at the start";

// ---------- Spec de edicion ----------
function buildSpec(req: any, script: any, clipUrls: string[], screens: string[]) {
  const plan = PLAN[req.duration];
  const edit = req.edit || {};
  const textos = edit.textos !== false;
  const overlays: string[] = [];
  if (edit.celular_app !== false && screens.length) overlays.push(...screens.map((s) => "phone:" + s));
  else if (edit.foto_producto !== false && req.product_image) overlays.push("photo:" + req.product_image);
  const scenes: any[] = [];
  let cutN = 0, ov = 0;
  const totalCuts = plan.clips.reduce((n, s) => n + cutsFor(s).length, 0);
  plan.clips.forEach((secs, ci) => {
    const tx = script.clips[ci]?.textos || [];
    cutsFor(secs).forEach((c, k) => {
      const punch = cutN % 2 ? 1.18 : 1.0;
      // Celular o foto: desde el segundo corte, sin tapar el gancho ni el ultimo corte (cara completa antes del cierre)
      let over: string | null = null;
      if (overlays.length && cutN >= 1 && cutN < totalCuts - 1) {
        if (overlays[0].startsWith("phone:") ? ov < overlays.length : cutN % 2 === 1) over = overlays[Math.min(ov, overlays.length - 1)];
      }
      const items: any[] = [];
      if (over) {
        const [kind, src] = [over.slice(0, over.indexOf(":")), over.slice(over.indexOf(":") + 1)];
        items.push({ t: "phone", src, style: kind === "photo" ? "photo" : "phone", w: kind === "photo" ? 600 : 560, x: "C", y: kind === "photo" ? 860 : 880, at: 0.15 });
        if (kind === "phone") ov++;
      }
      const t = tx[k];
      if (textos && t?.texto) {
        items.push({ t: "text", text: t.texto, size: t.texto.length > 22 ? 56 : 66, w: 900, color: t.acento ? "orange" : "white", x: "C", y: over ? 1610 : 1480, at: 0.1 });
      }
      scenes.push({ dur: c.dur, bg: { clip: ci, start: c.start, scrim: over ? 0.3 : 0.1, zoom: 0.02, punch }, items });
      cutN++;
    });
  });
  const cierre = script.cierre || {};
  const contacto = req.tenant_id === AQ ? "o al WhatsApp +57 310 219 7559" : "Pago contra entrega · hallazgo.shop";
  scenes.push({ dur: plan.card, items: textos ? [
    { t: "text", text: cierre.titulo || req.product_name, size: 84, w: 900, color: "white", x: "C" },
    { t: "text", text: cierre.subtitulo || "", size: 50, w: 700, color: "dato", x: "C", at: 0.3 },
    { t: "rich", parts: [["Escribe ", "white"], [String(cierre.palabra || "INFO").toUpperCase(), "orange"]], size: 64, x: "C", at: 0.7 },
    { t: "text", text: contacto, size: 44, w: 700, color: "dato", x: "C", at: 1.0 },
    { t: "text", text: "Presentadora creada con IA", size: 28, w: 500, color: "white", x: "C", at: 1.2 },
  ] : [{ t: "text", text: "Presentadora creada con IA", size: 28, w: 500, color: "white", x: "C" }] });
  return {
    kind: "reel", title: `UGC ${req.model_slug}: ${req.product_name}`, voice: true, voice_model: req.model_slug, speed: 1.1, cover_at: 1.0,
    brand: req.tenant_id === AQ, ugc_request_id: req.id,
    clips: clipUrls.map((url) => ({ url })), scenes,
  };
}

function buildFilmSpec(req: any, script: any, clipUrls: string[]) {
  const plan = planFor(req);
  const speed = 1.1, head = 0.25, tail = 0.35;
  const textos = (req.edit || {}).textos !== false;
  const scenes: any[] = [];
  plan.clips.forEach((secs, i) => {
    const e = script.escenas[i] || {};
    const dur = Number(((secs - head - tail) / speed).toFixed(2));
    const items: any[] = [];
    if (textos) {
      if (Array.isArray(e.pasos) && e.pasos.length) {
        // Como funciona: 3 pasos numerados que entran uno tras otro y se quedan
        const step = (dur - 0.4) / e.pasos.length;
        e.pasos.slice(0, 3).forEach((p: string, k: number) => {
          items.push({ t: "cap", lines: [[`${k + 1}. ${p}`, k === e.pasos.length - 1 ? "yellow" : "white"]], size: 64, x: "C", y: 1240 + k * 110, at: 0.2 + k * step });
        });
      } else {
        const blocks: any[] = (e.subtitulos || []).slice(0, 2);
        const win = dur / Math.max(1, blocks.length);
        blocks.forEach((b: any, k: number) => {
          const lines = (Array.isArray(b) ? b : [b]).slice(0, 3).map((l: any) => [String(l.t || l.texto || l), l.acento ? "yellow" : "white"]);
          const long = Math.max(...lines.map((l: any) => l[0].length));
          items.push({ t: "cap", lines, size: long > 12 ? 82 : 96, x: "C", y: 1380, at: 0.05 + k * win, ...(k < blocks.length - 1 ? { until: (k + 1) * win } : {}) });
        });
      }
    }
    scenes.push({ dur, brand: false, bg: { clip: i, start: head, scrim: 0, zoom: 0.035, punch: 1.0 }, items });
  });
  const cierre = script.cierre || {};
  const contacto = req.tenant_id === AQ ? "o al WhatsApp +57 310 219 7559" : "Pago contra entrega · hallazgo.shop";
  scenes.push({ dur: plan.card, brand: true, items: [
    { t: "text", text: cierre.titulo || req.product_name, size: 84, w: 900, color: "white", x: "C" },
    { t: "text", text: cierre.subtitulo || "", size: 50, w: 700, color: "dato", x: "C", at: 0.3 },
    { t: "rich", parts: [["Escribe ", "white"], [String(cierre.palabra || "INFO").toUpperCase(), "orange"]], size: 64, x: "C", at: 0.6 },
    { t: "text", text: contacto, size: 44, w: 700, color: "dato", x: "C", at: 0.9 },
    { t: "text", text: "Presentadora creada con IA", size: 28, w: 500, color: "white", x: "C", at: 1.1 },
  ] });
  return {
    kind: "reel", title: `UGC ${req.model_slug}: ${req.product_name}`, voice: true, voice_model: req.model_slug, speed, cover_at: 0.8,
    brand: req.tenant_id === AQ, transition: "whip", ugc_request_id: req.id,
    clips: clipUrls.map((url) => ({ url })), scenes,
  };
}

async function dispatch(jobId: string) {
  const token = await asecret("analytiq_github_token");
  if (!token) throw new Error("Falta analytiq_github_token en el Vault");
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/render.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ugc-director", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: GH_REF, inputs: { job_id: jobId } }),
  });
  if (r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ---------- Pasos ----------
async function stepNewFilm(req: any, model: any, orderId: string) {
  const plan = planFor(req);
  // Fase 1: guion por ambientes (Claude Console). Cada fase va en un tick distinto para no pasar el limite de tiempo.
  if (!(req.script?.escenas?.length >= plan.clips.length)) {
    const script = await claudeFilm(req, model, plan);
    await setReq(req.id, { script, error: null });
    return { id: req.id, fase: "guion" };
  }
  const script = req.script;
  // Fase 2: imagen de cada ambiente con la modelo (Gemini, calidad final), en paralelo
  const faltan = script.escenas.map((e: any, i: number) => (e.img ? -1 : i)).filter((i: number) => i >= 0);
  if (faltan.length) {
    const refs = [model.photos?.maquillaje || model.photos?.frente_sonrisa, model.photos?.cuerpo_entero, model.look].filter(Boolean);
    const res = await Promise.all(faltan.map((i: number) => callFn("ugc-studio", {
      action: "generate", quality: "final", slug: req.model_slug, step: `pedido_${req.id.slice(0, 8)}_amb${i + 1}`, order_id: orderId,
      refs, prompt: filmImagePrompt(script.escenas[i]), n: 1,
    }).then(async (r: any) => {
      // Cada imagen se guarda apenas llega: si la funcion se corta por tiempo no se pierde lo ya pagado
      const url = r?.images?.[0]?.url;
      if (url) { script.escenas[i].img = url; await setReq(req.id, { script }); }
      return r;
    }).catch((e) => ({ error: String(e.message) }))));
    const errs: string[] = [];
    faltan.forEach((i: number, k: number) => {
      if (!script.escenas[i].img) errs.push(res[k]?.images?.[0]?.error || res[k]?.error || "sin imagen");
    });
    if (errs.length) throw new Error("Imagenes: " + errs[0]);
    return { id: req.id, fase: "imagenes" };
  }
  // Fase 3: un clip de Veo por ambiente. Veo limita cuantos clips arrancan por minuto:
  // cada clip iniciado queda guardado en su escena y, si Veo pide esperar, el siguiente tick sigue donde quedo.
  for (let i = 0; i < plan.clips.length; i++) {
    const e = script.escenas[i];
    if (e.gen) continue;
    try {
      const r = await callFn("ugc-studio", { action: "veo_start", slug: req.model_slug, step: `pedido_${req.id.slice(0, 8)}_amb${i + 1}`, seconds: plan.clips[i],
        resolution: "720p", image_url: e.img, order_id: orderId, prompt: filmVeoPrompt(e), negative: NEG });
      e.gen = r.generation_id;
      await setReq(req.id, { script });
    } catch (err) {
      const msg = String((err as Error).message || err);
      if (/quota|exceeded|rate|RESOURCE_EXHAUSTED|high demand/i.test(msg)) {
        await setReq(req.id, { script, error: `Veo pidio esperar, ${i} de ${plan.clips.length} tomas iniciadas` });
        return { id: req.id, fase: "tomas", iniciadas: i };
      }
      throw err;
    }
  }
  const ids = script.escenas.slice(0, plan.clips.length).map((e: any) => e.gen);
  await setReq(req.id, { clip_ids: ids, status: "generando", error: null });
  return { id: req.id, status: "generando", clips: ids.length };
}

async function stepNew(req: any) {
  const plan = planFor(req);
  const { data: model } = await sb.from("ugc_models").select("*").eq("slug", req.model_slug).single();
  if (!model) throw new Error("No existe la modelo " + req.model_slug);
  const image = model.look || model.photos?.para_animar;
  if (!image) throw new Error("La modelo no tiene foto para animar");
  let orderId = req.order_id;
  if (!orderId) {
    const { data: o } = await sb.from("ugc_orders").insert({ model_slug: req.model_slug, title: `${NEGOCIO[req.tenant_id] || ""}: ${req.product_name}`, format: `ugc_${req.duration}s`, price_cop: 0, status: "en_produccion" }).select("id").single();
    orderId = o!.id; req.order_id = orderId;
    await setReq(req.id, { order_id: orderId });
  }
  if (isFilm(req)) return await stepNewFilm(req, model, orderId);
  // Si un intento anterior ya escribio el guion, se reutiliza (no se paga dos veces)
  const script = req.script?.clips?.length >= plan.clips.length ? req.script : await claudeScript(req, model, plan);
  if (script !== req.script) await setReq(req.id, { script });
  const ids: string[] = [];
  for (let i = 0; i < plan.clips.length; i++) {
    const c = script.clips[i];
    const r = await callFn("ugc-studio", { action: "veo_start", slug: req.model_slug, step: `pedido_${req.id.slice(0, 8)}_c${i + 1}`, seconds: plan.clips[i],
      resolution: "720p", image_url: image, order_id: orderId, prompt: veoPrompt(model, c.linea, c.gesto), negative: NEG });
    ids.push(r.generation_id);
  }
  await setReq(req.id, { clip_ids: ids, status: "generando", error: null });
  return { id: req.id, status: "generando", clips: ids.length };
}

async function stepClips(req: any) {
  const urls: string[] = [];
  for (const [ci, gid] of (req.clip_ids || []).entries()) {
    const s = await callFn("ugc-studio", { action: "veo_status", generation_id: gid });
    if (s.status === "error" && isFilm(req) && (req.script.escenas[ci].fallos || 0) < 2) {
      // Pelicula: si Veo bloquea o falla una toma, se repite solo esa (hasta 2 veces) y lo demas se conserva
      const script = req.script;
      script.escenas[ci].fallos = (script.escenas[ci].fallos || 0) + 1;
      delete script.escenas[ci].gen;
      await setReq(req.id, { script, status: "nuevo", clip_ids: [], error: `Repitiendo toma ${ci + 1}: ${String(s.error || "").slice(0, 200)}` });
      return { id: req.id, repite: ci + 1 };
    }
    if (s.status === "error") throw new Error("Un clip fallo en Veo: " + (s.error || ""));
    if (s.status !== "listo") return { id: req.id, waiting: true };
    urls.push(s.url);
  }
  let screens: string[] = [];
  if (req.product_ref) {
    const { data: p } = await sb.from("ugc_products").select("app_screens").eq("tenant_id", req.tenant_id).eq("ref", req.product_ref).maybeSingle();
    screens = p?.app_screens || [];
  }
  const spec = isFilm(req) ? buildFilmSpec(req, req.script, urls) : buildSpec(req, req.script, urls, screens);
  let music: string | null = null;
  if ((req.edit || {}).musica !== false) {
    try { music = (await callFn("analytiq-studio", { action: "music", slug: `ugc-${req.id.slice(0, 8)}`, prompt: req.script.music_prompt || "Upbeat modern Latin pop instrumental, energetic, low background music under a voice, no vocals, 30 seconds." })).url; }
    catch (_) { music = null; }
  }
  const { data: job, error } = await sb.from("analytiq_content_jobs").insert({
    tenant_id: req.tenant_id, kind: "reel", title: spec.title, caption: req.script.caption, spec, music_url: music, status: "rendering",
  }).select("id").single();
  if (error) throw new Error("job: " + error.message);
  await dispatch(job!.id);
  await setReq(req.id, { job_id: job!.id, status: "editando" });
  return { id: req.id, status: "editando", job: job!.id };
}

async function stepRender(req: any) {
  const { data: job } = await sb.from("analytiq_content_jobs").select("status,files,approval_id,error").eq("id", req.job_id).single();
  if (!job) throw new Error("No existe el trabajo de edicion");
  if (job.status === "error") throw new Error("La edicion fallo: " + (job.error || ""));
  if (job.status !== "pending_approval" || !job.approval_id) return { id: req.id, waiting: true };
  const video = (job.files || []).find((f: string) => f.endsWith(".mp4")) || null;
  const cover = (job.files || []).find((f: string) => f.endsWith(".png")) || null;
  // El estudio crea la aprobacion en AnalytiQ: se pasa al negocio del pedido y se le agrega el link para revisar
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

// Aprobado en la Torre: AnalytiQ pasa al calendario de redes (sale en la siguiente ronda del publicador).
// Hallazgo publica con su propio motor, que todavia no sube videos: el video queda listo para usar.
async function bridge() {
  const { data: aps } = await sb.from("com_approvals").select("*").eq("type", "creative").eq("status", "approved").gte("decided_at", BRIDGE_SINCE).limit(10);
  const out: any[] = [];
  for (const ap of aps || []) {
    const p = ap.payload || {};
    if (!p.job_id && !p.ugc_request_id) continue;
    try {
      if (p.ugc_request_id) await setReq(p.ugc_request_id, { status: "aprobado" });
      if (ap.tenant_id === AQ && p.job_id) {
        const { data: job } = await sb.from("analytiq_content_jobs").select("*").eq("id", p.job_id).single();
        const files: string[] = job?.files || [];
        const video = files.find((f) => f.endsWith(".mp4"));
        const media = job?.kind === "reel" ? [video, files.find((f) => f.endsWith(".png"))].filter(Boolean) : files.filter((f) => f.endsWith(".png"));
        if (!media.length) throw new Error("La pieza no tiene archivos");
        const when = p.publicar && new Date(p.publicar) > new Date() ? p.publicar : new Date().toISOString();
        const kind = job.kind === "post" ? (media.length > 1 ? "carousel" : "image") : job.kind;
        const rows = ["instagram", "facebook"].map((channel) => ({ tenant_id: AQ, channel, kind, caption: job.caption || p.copy || "", hashtags: [], media_urls: media,
          product_ref: p.ugc_request_id ? `ugc-${String(p.ugc_request_id).slice(0, 8)}` : `job-${String(p.job_id).slice(0, 8)}`, scheduled_at: when, status: "scheduled", created_by: "ugc-director" }));
        const { error } = await sb.from("com_social_posts").insert(rows);
        if (error) throw new Error("calendario: " + error.message);
        await sb.from("analytiq_content_jobs").update({ status: "scheduled", updated_at: new Date().toISOString() }).eq("id", p.job_id);
        await sb.from("com_approvals").update({ status: "done", payload: { ...p, resultado: `Programado para ${when}` } }).eq("id", ap.id);
        out.push({ id: ap.id, programado: when });
      } else {
        await sb.from("com_approvals").update({ status: "done", payload: { ...p, resultado: "Video aprobado y listo para usar en pauta o redes" } }).eq("id", ap.id);
        out.push({ id: ap.id, listo: true });
      }
    } catch (e) {
      out.push({ id: ap.id, error: String((e as Error).message) });
    }
  }
  // Rechazados en la Torre
  const { data: rej } = await sb.from("com_approvals").select("payload").eq("status", "rejected").gte("decided_at", BRIDGE_SINCE).not("payload->ugc_request_id", "is", null).limit(20);
  for (const r of rej || []) await sb.from("ugc_requests").update({ status: "rechazado" }).eq("id", r.payload.ugc_request_id).eq("status", "por_aprobar");
  return out;
}

// Miniatura cuadrada (cara) de cada modelo para las cards circulares de la Torre
async function thumbs() {
  const { data } = await sb.from("ugc_models").select("slug,photos,look,thumb").is("thumb", null);
  const out: string[] = [];
  for (const m of data || []) {
    const src = m.photos?.frente_sonrisa || m.look || m.photos?.para_animar;
    if (!src) continue;
    const r = await fetch(src);
    if (!r.ok) continue;
    const img = await Image.decode(new Uint8Array(await r.arrayBuffer()));
    const side = Math.min(img.width, Math.round(img.height * 0.55));
    const x = Math.round((img.width - side) / 2), y = Math.round(img.height * 0.06);
    img.crop(x, y, side, Math.min(side, img.height - y)).resize(220, 220);
    const b64 = encodeBase64(await img.encodeJPEG(82));
    await sb.from("ugc_models").update({ thumb: "data:image/jpeg;base64," + b64 }).eq("slug", m.slug);
    out.push(m.slug);
  }
  return out;
}

async function tick() {
  const { data: reqs } = await sb.from("ugc_requests").select("*").in("status", ["nuevo", "generando", "editando"]).lt("attempts", 3).order("created_at").limit(6);
  const out: any[] = [];
  for (const req of reqs || []) {
    try {
      if (req.status === "nuevo") out.push(await stepNew(req));
      else if (req.status === "generando") out.push(await stepClips(req));
      else if (req.status === "editando") out.push(await stepRender(req));
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 500);
      const attempts = (req.attempts || 0) + 1;
      // Si fallo despues del guion, reintenta desde el principio de ese paso
      await setReq(req.id, { attempts, error: msg, status: attempts >= 3 ? "error" : req.status });
      out.push({ id: req.id, error: msg });
    }
  }
  let mini: unknown = [];
  try { mini = await thumbs(); } catch (e) { mini = String((e as Error).message); }
  return { pedidos: out, puente: await bridge(), miniaturas: mini };
}

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-cron-secret") !== (await hsecret("hallazgo_cron_secret"))) return json({ error: "unauthorized" }, 401);
    const b = await req.json().catch(() => ({}));
    let result: unknown;
    if (b.action === "bridge") result = await bridge();
    else if (b.action === "plan") {
      const { data: r } = await sb.from("ugc_requests").select("*").eq("id", b.id).single();
      const { data: m } = await sb.from("ugc_models").select("*").eq("slug", r.model_slug).single();
      result = isFilm(r) ? await claudeFilm(r, m, planFor(r)) : await claudeScript(r, m, planFor(r));
    } else result = await tick();
    return json({ ok: true, result });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
