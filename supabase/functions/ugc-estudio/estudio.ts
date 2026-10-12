// Estudio por roles (pedidos con brief del formulario de la Torre).
// Cada agente de IA recibe solo su bloque del formulario y lo que decidieron los anteriores:
//   ejecutiva -> director -> guionista -> coach de acento -> directora de arte -> vestuarista -> directora de actores
// Luego la camarografa arma cada toma con la receta del corto v5 (Veo con fotos de referencia del personaje,
// horizontal 16:9 recortado a cuadrado, voz nativa unificada con la voz clonada de la modelo) y el editor arma el corte.

export const TAKES: Record<number, number> = { 10: 2, 15: 2, 30: 4 };
export const takesFor = (req: any) => TAKES[req.duration] || 2;
export const veoModelFor = (req: any) => (req.brief?.calidad === "estandar" ? "veo-3.1-fast-generate-preview" : "veo-3.1-generate-preview");

const REGLAS = `Reglas de la agencia (aprendidas en produccion, no las rompas):
- Espanol de Colombia. NUNCA voseo argentino (pensas, conoces, tenes, mira, queres): el motor de video lo convierte en acento argentino. Usa usted o tu segun el brief.
- Nada de testimonios falsos, cifras o clientes inventados. No uses nombres propios de personas en lo que dice la modelo (el motor de video los bloquea).
- Cada toma dura 8 segundos: maximo 18 palabras habladas, con una pausa corta permitida.
- Acciones fisicas simples y creibles. Nada magico, nada que aparezca de la nada. Selfie de celular, cara centrada y cerca.
- La modelo tiene exactamente dos brazos: un brazo sostiene el celular (casi fuera de cuadro) y el otro queda relajado; nunca un brazo detras o encima de la cabeza.
- NUNCA uses guion largo ni guion medio como pausa.`;

export const ROLES: { key: string; nombre: string; system: string; input: (ctx: any) => string }[] = [
  {
    key: "ejecutiva", nombre: "Ejecutiva de cuenta",
    system: `Eres la ejecutiva de cuenta de una agencia de videos UGC con modelos virtuales en Medellin. Conviertes el formulario del cliente en un brief claro y fiel, sin inventar nada.
${REGLAS}
Devuelve con la herramienta: {"resumen":"2 frases del negocio y lo que vende","oferta":"oferta o precio tal cual, o vacio","objetivo":"...","publico":"...","cta_frase":"frase exacta del llamado a la accion en el trato del brief","palabra":"palabra clave o dato del llamado","prohibido":["..."],"frases_obligatorias":["..."]}`,
    input: (c) => `${c.base}

Bloque NEGOCIO del formulario:
${c.bloque(["negocio", "objetivo", "oferta", "publico", "cta", "palabra", "prohibido"])}
Trato: ${c.b.trato || "usted"}. Frases obligatorias: ${c.b.frases || "ninguna"}`,
  },
  {
    key: "director", nombre: "Director",
    system: `Eres el director de cortos publicitarios verticales que atrapan como una pelicula (estilo del reel de referencia de ugc.studio.ia: gancho con suspenso, revelacion, montaje rapido, explicacion simple, cierre que vuelve al inicio para que el video se repita).
${REGLAS}
Devuelve con la herramienta: {"titulo":"...","logline":"una frase","tomas":[{"n":1,"proposito":"que logra esta toma","emocion":"una emocion clara","idea_linea":"de que habla, sin escribir la linea final"}],"revelacion":{"toma":numero o null,"texto":["LINEA 1","LINEA 2"]},"pasos":{"toma":numero o null,"lista":["max 4 palabras","...","..."]},"musica_prompt":"en ingles: instrumental de unos 30 s con el arco del video, sin voces"}
La primera y la ultima toma ocurren en el mismo lugar (bucle). "pasos" solo si el formato necesita explicar como funciona.`,
    input: (c) => `${c.base}

Brief de la ejecutiva:
${JSON.stringify(c.r.ejecutiva)}

Bloque IDEA y TIPO del formulario:
${c.bloque(["formato", "duracion", "gancho", "tono", "ritmo"])}
Numero de tomas de 8 s: ${c.n}.`,
  },
  {
    key: "guionista", nombre: "Guionista",
    system: `Eres el guionista. Escribes lo que la modelo dice en cada toma y los textos de pantalla.
${REGLAS}
Devuelve con la herramienta: {"tomas":[{"n":1,"linea":"texto exacto, max 18 palabras","beats":[{"desde":0,"hasta":3,"dice":"..."},{"desde":3,"hasta":8,"dice":"..."}],"textos":[{"texto":"max 4 palabras","at":0.2,"estilo":"manuscrito|grande","clave":false}]}],"caption":"copy para Instagram de 3 a 5 lineas con el llamado a la accion y 5 hashtags"}
Los beats suman la linea completa sin cambiar palabras. "at" es el segundo dentro de la toma (0 a 7.5). Maximo 3 textos por toma; la ultima toma lleva el llamado a la accion en manuscrito.`,
    input: (c) => `${c.base}

Brief de la ejecutiva:
${JSON.stringify(c.r.ejecutiva)}

Tratamiento del director:
${JSON.stringify(c.r.director)}

Trato: ${c.b.trato || "usted"}. Frases que deben aparecer tal cual: ${c.b.frases || "ninguna"}.`,
  },
  {
    key: "acento", nombre: "Coach de acento",
    system: `Eres coach de acento colombiano. Revisas cada linea para que suene natural en el acento pedido y la corriges solo si hace falta (mismo sentido, mismas o menos palabras). Quitas cualquier voseo argentino. Agregas muletillas solo de la lista permitida y con moderacion.
${REGLAS}
Devuelve con la herramienta: {"tomas":[{"n":1,"linea":"...","beats":[{"desde":0,"hasta":3,"dice":"..."}]}],"voz_en":"English instruction for the video model describing accent and delivery, e.g. She speaks Colombian Spanish from Medellin with a soft melodic paisa intonation... Not an Argentine accent."}`,
    input: (c) => `Guion:
${JSON.stringify((c.r.guionista?.tomas || []).map((t: any) => ({ n: t.n, linea: t.linea, beats: t.beats })))}

Bloque VOZ del formulario:
${c.bloque(["trato", "acento", "muletillas"])}
Voz de la modelo: ${c.m.voice_desc || "young warm female voice"}. Personalidad pedida: ${c.label("tono")}.`,
  },
  {
    key: "arte", nombre: "Directora de arte",
    system: `Eres directora de arte. Asignas un ambiente a cada toma (lugar, luz, que se ve alrededor) usando los lugares pedidos. La primera y la ultima toma en el mismo lugar. Gente lejos y desenfocada, nunca interactuando. Nada de texto legible ni logos en el fondo.
${REGLAS}
Devuelve con la herramienta: {"tomas":[{"n":1,"lugar":"...","escena_en":"English: location, light, what is around, framing. Selfie with the phone's front camera at arm's length, her face centered and close."}]}`,
    input: (c) => `Tratamiento del director:
${JSON.stringify(c.r.director?.tomas || [])}

Bloque AMBIENTES del formulario:
${c.bloque(["lugares", "luz", "fotos_local"])}
Negocio: ${c.r.ejecutiva?.resumen || ""}`,
  },
  {
    key: "vestuario", nombre: "Vestuarista",
    system: `Eres vestuarista. Defines una sola ropa, peinado y accesorios para todo el video (salvo que el brief pida cambiar), coherentes con la marca y con la personalidad. Prendas lisas, sin texto ni logos.
${REGLAS}
Devuelve con la herramienta: {"look_en":"English: outfit, colors, hairstyle, accessories, makeup level. Natural skin with real texture, no heavy makeup.","misma_ropa":true}`,
    input: (c) => `Bloque VESTUARIO del formulario:
${c.bloque(["estilo", "colores", "color_marca", "peinado", "misma_ropa"])}
Modelo: ${c.m.name}, ${c.m.age} anos. Personalidad: ${c.label("tono")}.`,
  },
  {
    key: "actores", nombre: "Directora de actores",
    system: `Eres directora de actores. Para cada toma escribes la actuacion segundo a segundo (gestos, miradas, que hace con el producto), sincronizada con los beats del guion, sin repetir el dialogo.
${REGLAS}
Devuelve con la herramienta: {"personalidad_en":"English: personality and energy in one sentence, e.g. She is mysterious, calm and confident; no laughing.","tomas":[{"n":1,"actuacion_en":"English: 0-3s: ... 3-8s: ..."}]}`,
    input: (c) => `Guion final con beats:
${JSON.stringify((c.r.acento?.tomas || c.r.guionista?.tomas || []).map((t: any) => ({ n: t.n, beats: t.beats })))}
Ambientes: ${JSON.stringify((c.r.arte?.tomas || []).map((t: any) => ({ n: t.n, lugar: t.lugar })))}

Bloque INTERACCIONES del formulario:
${c.bloque(["accion", "gestos", "mirada"])}
Personalidad pedida: ${c.label("tono")}. Producto: ${c.prod}.`,
  },
];

// Camarografa: arma la orden de cada toma para Veo con todo lo que decidio el equipo
export function takePrompt(r: any, i: number) {
  const n = i + 1;
  const pick = (arr: any) => { const a = Array.isArray(arr) ? arr : []; return a.find((t: any) => Number(t?.n) === n) || a[i] || {}; };
  const g = pick(r.acento?.tomas) as any, g0 = pick(r.guionista?.tomas) as any;
  const linea = String(g.linea || g0.linea || "").replace(/"/g, "'");
  const beats = (g.beats || g0.beats || []).map((b: any) => `${b.desde}-${b.hasta}s she says: "${String(b.dice || "").replace(/"/g, "'")}"`).join(" ");
  const escena = (pick(r.arte?.tomas) as any).escena_en || "In her bedroom with natural window light, selfie with the phone's front camera at arm's length.";
  const actuacion = (pick(r.actores?.tomas) as any).actuacion_en || "";
  return [
    "Raw selfie video filmed by the woman from the reference images with her phone's front camera held at arm's length.",
    escena,
    r.vestuario?.look_en || "",
    "Her face stays centered in the frame and close; the camera wobbles slightly as she holds the phone. She has exactly two arms: one holds the phone almost out of frame, the other rests relaxed; never an arm behind or above her head.",
    r.actores?.personalidad_en || "",
    r.acento?.voz_en || "She speaks Colombian Spanish from Medellin with a soft melodic paisa intonation, natural speed. Not an Argentine accent.",
    actuacion ? "Acting: " + actuacion : "",
    beats ? "Dialogue timing: " + beats : "",
    `Exact words: "${linea}"`,
    "Real unedited phone video, ambient sound only. No music, no subtitles, no on-screen text, no slow motion, the phone is not visible.",
  ].filter(Boolean).join(" ");
}

// Editor: corte cuadrado tipo cine (o vertical), con revelacion oscura, pasos, textos y cierre
export function buildBriefSpec(req: any, script: any, clipUrls: string[], model: any) {
  const r = script.roles, b = req.brief || {}, edit = req.edit || {};
  const SP = 1.05, head = 0.3, tail = 0.4;
  const square = b.encuadre !== "vertical";
  const tomas = (r.acento?.tomas?.length ? r.acento.tomas : r.guionista?.tomas) || [];
  const textosOn = b.textos !== "sin";
  const refs: string[] = model.ref_photos || [];
  const yTxt = square ? 1310 : 1420, yBig = square ? 1050 : 1250;
  const t = (s: number) => Math.round((s / SP) * 100) / 100;
  const caps = (list: any[], from: number, to: number) => (list || []).filter((x: any) => x.at >= from && x.at < to).slice(0, 3).map((x: any, k: number, arr: any[]) => {
    const grande = x.estilo === "grande" || b.textos === "grandes";
    const manus = !grande || b.textos === "manuscritos";
    const words = String(x.texto || "").trim();
    const lines = words.length > 14 && manus ? [[words.slice(0, words.lastIndexOf(" ", 14) > 0 ? words.lastIndexOf(" ", 14) : 14).trim(), "white"], [words.slice(words.lastIndexOf(" ", 14) > 0 ? words.lastIndexOf(" ", 14) : 14).trim(), x.clave ? "yellow" : "white"]] : [[manus ? words : words.toUpperCase(), x.clave ? "yellow" : "white"]];
    const item: any = { t: "cap", font: manus ? "caveat" : "anton", lines, size: manus ? 120 : 140, x: "C", y: manus ? yTxt : yBig, at: t(Math.max(0, x.at - from)) };
    const next = arr[k + 1];
    if (next) item.until = t(next.at - from); else item.hold = true;
    return item;
  });
  const scenes: any[] = [];
  clipUrls.forEach((_, i) => {
    const g = (r.guionista?.tomas || [])[i] || {};
    const textos = textosOn ? (g.textos || []) : [];
    const last = i === clipUrls.length - 1;
    const end = 8 - tail;
    const rev = r.director?.revelacion?.toma === i + 1, pas = r.director?.pasos?.toma === i + 1;
    const split = rev ? 5.4 : pas ? 3.2 : null;
    const sc1: any = { dur: t((split ?? end) - head), brand: false, bg: { clip: i, start: head, scrim: 0, zoom: 0.05, punch: 1.0 }, items: caps(textos, head, split ?? 99) };
    if (i > 0) sc1.whoosh = true;
    if (rev) sc1.sfx = ["riser"];
    scenes.push(sc1);
    if (split !== null) {
      const items: any[] = [];
      if (rev) {
        if (b.extras?.includes?.("fotos")) refs.slice(0, 3).forEach((u, k) => items.push({ t: "phone", src: u, style: "photo", w: k === 1 ? 270 : 230, x: [90, 405, 760][k], y: [560, 500, 580][k], at: 0.05 + k * 0.15, hold: true }));
        const tx = (r.director.revelacion.texto || []).slice(0, 2);
        if (tx.length) items.push({ t: "cap", font: "anton", lines: tx.map((l: string, k: number) => [String(l).toUpperCase(), k === tx.length - 1 ? "yellow" : "white"]), size: 150, x: "C", y: 1120, at: 0.45, hold: true });
      } else {
        (r.director.pasos.lista || []).slice(0, 3).forEach((p: string, k: number) => items.push({ t: "cap", font: "anton", lines: [[`${k + 1}. ${String(p).toUpperCase()}`, "white"]], size: 78, x: "C", y: 800 + k * 120, at: 0.15 + k * 1.2, hold: true }));
        if (edit.foto_producto && req.product_image) items.push({ t: "phone", src: req.product_image, style: "photo", w: 260, x: "C", y: 480, at: 0.1, hold: true });
      }
      scenes.push({ dur: t(end - split), brand: false, bg: { clip: i, start: split, scrim: rev ? 0.86 : 0.9, zoom: 0.02, punch: 1.0 }, items, ...(rev ? { sfx: ["impact"] } : {}) });
    }
    if (last) {
      const s = scenes[scenes.length - 1];
      if (req.tenant_id === "c6e4b4ac-8904-458e-aa70-a8b348269fe9" && b.extras?.includes?.("logo")) s.items.push({ t: "logo", w: 440, y: square ? 560 : 300, at: 0.4, hold: true });
    }
  });
  return {
    kind: "reel", title: `UGC ${req.model_slug}: ${req.product_name}`, frame: square ? "square" : undefined, voice: true,
    voice_model: model.voice_id && model.voice_is_clone ? req.model_slug : undefined, speed: SP, brand: false, end_dark: true, cover_at: 0.3,
    music_volume: b.musica === "suspenso" ? 0.22 : 0.16, ugc_request_id: req.id, clips: clipUrls.map((url) => ({ url })), scenes,
  };
}
