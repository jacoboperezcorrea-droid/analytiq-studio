"""Motor de render de AnalytiQ Core.

Convierte una especificacion JSON en piezas de marca:
  - reel: video vertical 1080x1920 con textos animados
  - carousel / post: PNG 1080x1350
  - story: PNG 1080x1920 (una imagen por slide)

Elementos soportados en cada escena o slide (campo "t"):
  text    texto con ajuste de linea automatico
  rich    una linea con partes de distinto color  parts=[["Escribe ","white"],["CUENTA","orange"]]
  counter numero que sube hasta "to" (formato pesos o porcentaje)
  pop     texto grande que entra con rebote (ideal para una cifra clave)
  bar     barra horizontal proporcional (frac 0..1)
  line    linea divisoria
  box     recuadro con borde
Posiciones: x = "L" (izquierda), "C" (centro), "R" (derecha) o un numero; y en pixeles.
Tiempos (solo reel): "at" = segundo dentro de la escena en que aparece el elemento.
"""
import math, os, subprocess
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "..", "fonts", "montserrat-latin-{}-normal.woff")

BG = (10, 46, 74)          # Azul Profundo #0A2E4A
COLORS = {
    "white": (255, 255, 255),
    "orange": (230, 101, 33),  # Naranja Core #E66521, solo acentos
    "dato": (75, 160, 199),    # Azul Dato #4BA0C7
    "bg": BG,
}
GRID = (16, 57, 89)
MARGIN = 90
BOX_PAD = 40

_fc = {}
def font(weight, size):
    k = (int(weight), max(8, int(size)))
    if k not in _fc:
        _fc[k] = ImageFont.truetype(FONT.format(k[0]), k[1])
    return _fc[k]

def clamp(x): return max(0.0, min(1.0, x))
def ease_out(x): x = clamp(x); return 1 - (1 - x) ** 3
def ease_back(x):
    x = clamp(x); c1 = 1.70158; c3 = c1 + 1
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
def col(name): return COLORS.get(name, COLORS["white"]) if isinstance(name, str) else tuple(name)
def mix(c, a): return tuple(int(BG[i] + (c[i] - BG[i]) * a) for i in range(3))

def clean_prefix(it):
    pre = it.get("prefix", "")
    if it.get("style", "money") == "money":
        pre = pre.replace("$", "")
    return pre

def fmt_number(v, style):
    v = int(round(v))
    s = f"{v:,}".replace(",", ".")
    if style == "money": return "$" + s
    if style == "percent": return s + "%"
    return s

def wrap(draw, text, f, maxw):
    lines = []
    for para in str(text).split("\n"):
        words, cur = para.split(" "), ""
        for w in words:
            test = (cur + " " + w).strip()
            if draw.textlength(test, font=f) <= maxw or not cur:
                cur = test
            else:
                lines.append(cur); cur = w
        lines.append(cur)
    return lines

class Canvas:
    def __init__(self, w, h, brand=True, grid_offset=0.0):
        self.w, self.h = w, h
        self.im = Image.new("RGB", (w, h), BG)
        self.d = ImageDraw.Draw(self.im)
        off = grid_offset % 90
        for gx in range(0, w + 90, 90):
            self.d.line([(gx - off, 0), (gx - off, h)], fill=GRID, width=1)
        for gy in range(0, h + 90, 90):
            self.d.line([(0, gy + off), (w, gy + off)], fill=GRID, width=1)
        if brand:
            by = 230 if h > 1500 else 80
            self.d.text((MARGIN, by), "AnalytiQ Core", font=font(700, 34), fill=COLORS["dato"])

    def xpos(self, x):
        if x in (None, "L"): return MARGIN, "l"
        if x == "C": return self.w // 2, "m"
        if x == "R": return self.w - MARGIN, "r"
        return int(x), "l"

    def draw(self, it, a, dy, local_t):
        """Dibuja un elemento con opacidad a, desplazamiento dy y tiempo local desde su aparicion."""
        if a <= 0.01: return
        d, t = self.d, it["t"]
        x, h = self.xpos(it.get("x"))
        y = it.get("y", 0) + dy
        c = mix(col(it.get("color", "white")), a)
        if t == "text":
            f = font(it.get("w", 700), it.get("size", 60))
            pad = BOX_PAD if it.get("boxed") else 0
            maxw = it.get("maxw", self.w - 2 * MARGIN) - 2 * pad
            lh = it.get("lh", 1.18) * it.get("size", 60)
            lines = wrap(d, it["text"], f, maxw)
            if pad:
                bh = len(lines) * lh + 2 * pad - (lh - it.get("size", 60))
                d.rounded_rectangle([MARGIN, y, self.w - MARGIN, y + bh], radius=28,
                                    outline=mix(col(it.get("box_color", "dato")), a), width=4)
                x = self.w // 2 if h == "m" else (x + pad if h == "l" else x - pad)
                y += pad
            for i, line in enumerate(lines):
                d.text((x, y + i * lh), line, font=f, fill=c, anchor=h + "a")
        elif t == "rich":
            f = font(it.get("w", 800), it.get("size", 54))
            total = sum(d.textlength(p[0], font=f) for p in it["parts"])
            cx = x - total / 2 if h == "m" else (x - total if h == "r" else x)
            for txt, cname in it["parts"]:
                d.text((cx, y), txt, font=f, fill=mix(col(cname), a))
                cx += d.textlength(txt, font=f)
        elif t == "counter":
            k = ease_out(local_t / it.get("dur", 1.2)) if local_t is not None else 1.0
            v = it.get("from", 0) + (it["to"] - it.get("from", 0)) * k
            txt = clean_prefix(it) + fmt_number(v, it.get("style", "money")) + it.get("suffix", "")
            d.text((x, y), txt, font=font(it.get("w", 900), it.get("size", 120)), fill=c, anchor=h + "a")
        elif t == "pop":
            sc = ease_back(local_t / 0.6) if local_t is not None else 1.0
            d.text((x, y), it["text"], font=font(it.get("w", 900), it.get("size", 300) * max(sc, 0.05)), fill=c, anchor=h + "m")
        elif t == "bar":
            k = ease_out((local_t - 0.1) / 0.6) if local_t is not None else 1.0
            full = it.get("width", self.w - 2 * MARGIN)
            bw = full * it.get("frac", 1.0) * k
            if bw > 2:
                d.rounded_rectangle([x, y, x + bw, y + it.get("thick", 14)], radius=it.get("thick", 14) // 2, fill=c)
        elif t == "line":
            k = ease_out(local_t / 0.5) if local_t is not None else 1.0
            full = it.get("width", self.w - 2 * MARGIN)
            d.line([(x, y), (x + full * k, y)], fill=c, width=it.get("thick", 4))
        elif t == "box":
            d.rounded_rectangle([x, y, x + it.get("width", self.w - 2 * MARGIN), y + it["height"]],
                                radius=it.get("radius", 28), outline=c, width=it.get("thick", 4))

# ---------- Acomodo automatico ----------
# Si los elementos de una escena/slide no traen "y", se apilan de arriba abajo, centrados en la
# zona segura, y se achican solos si no caben. Asi un guion escrito por IA nunca se monta.

_measure = ImageDraw.Draw(Image.new("RGB", (10, 10)))

def _final_text(it):
    if it["t"] == "counter":
        return clean_prefix(it) + fmt_number(it["to"], it.get("style", "money")) + it.get("suffix", "")
    if it["t"] == "rich":
        return "".join(p[0] for p in it["parts"])
    return it.get("text", "")

def measure(it, W):
    t, size = it["t"], it.get("size", 60)
    full = W - 2 * MARGIN
    if t == "text":
        pad = BOX_PAD if it.get("boxed") else 0
        f = font(it.get("w", 700), size)
        lh = it.get("lh", 1.18) * size
        n = len(wrap(_measure, it["text"], f, it.get("maxw", full) - 2 * pad))
        return n * lh - (lh - size) + 2 * pad + size * 0.25
    if t in ("counter", "rich", "pop"):
        return size * (1.0 if t == "pop" else 1.2)
    if t in ("bar", "line"):
        return it.get("thick", 14) + 6
    if t == "box":
        return it.get("height", 200)
    return size

def fit_width(it, W):
    """Achica elementos de una sola linea que no caben a lo ancho."""
    if it["t"] in ("counter", "rich", "pop"):
        full = W - 2 * MARGIN
        size = it.get("size", 60)
        while size > 24 and _measure.textlength(_final_text(it), font=font(it.get("w", 900 if it["t"] != "rich" else 800), size)) > full:
            size = int(size * 0.92)
        it["size"] = size

def layout(items, W, H):
    if any("y" in it for it in items):
        return items
    import copy
    items = copy.deepcopy(items)
    for k, it in enumerate(items):
        if it["t"] == "rich" and _measure.textlength(_final_text(it), font=font(it.get("w", 800), it.get("size", 54))) > (W - 2 * MARGIN):
            # Frase demasiado larga para una linea: pasa a texto normal y conserva el acento de color
            acento = next((c for _, c in it["parts"] if c != "white"), "white")
            items[k] = {"t": "text", "text": _final_text(it), "size": it.get("size", 54), "w": it.get("w", 800),
                        "color": acento if len(_final_text(it)) < 40 else "white", "x": it.get("x", "C"), "at": it.get("at", 0)}
    centrado = sum(1 for it in items if it.get("x") == "C") > len(items) / 2
    for it in items:
        if "x" not in it and centrado:
            it["x"] = "C"
    tall = H > 1500
    top, bottom = (330, H - 400) if tall else (170, H - 110)
    for _ in range(8):
        for it in items:
            fit_width(it, W)
        heights = [measure(it, W) for it in items]
        gaps = [0] + [it.get("gap", max(24, it.get("size", 60) * 0.5)) for it in items[1:]]
        total = sum(heights) + sum(gaps)
        if total <= bottom - top:
            break
        for it in items:
            if "size" in it:
                it["size"] = int(it["size"] * 0.9)
    y = top + max(0, (bottom - top - total) / 2) * 0.8
    for it, h, g in zip(items, heights, gaps):
        y += g
        it["y"] = int(y + (h / 2 if it["t"] == "pop" else 0))
        y += h
    return items

_lay_cache = {}
def laid(items, W, H):
    k = (id(items), W, H)
    if k not in _lay_cache:
        _lay_cache[k] = layout(items, W, H)
    return _lay_cache[k]

# ---------- Reel ----------

def reel_frame(spec, t):
    W, H = 1080, 1920
    cv = Canvas(W, H, brand=spec.get("brand", True), grid_offset=t * 12)
    start = 0.0
    scenes = spec["scenes"]
    for si, sc in enumerate(scenes):
        dur = sc["dur"]
        if start <= t < start + dur:
            lt = t - start
            last = si == len(scenes) - 1
            for it in laid(sc["items"], W, H):
                at = it.get("at", 0.0)
                a = ease_out((lt - at) / 0.35)
                if not last:
                    a *= 1 - ease_out((lt - (dur - 0.3)) / 0.3)
                dy = (1 - ease_out((lt - at) / 0.35)) * 40
                if it["t"] in ("pop", "bar", "line"):
                    dy = 0
                cv.draw(it, a, dy, lt - at)
            break
        start += dur
    total = sum(s["dur"] for s in scenes)
    if t > total - 0.4:
        k = clamp((t - (total - 0.4)) / 0.4)
        cv.im = Image.blend(cv.im, Image.new("RGB", (W, H), BG), k)
    return cv.im

def render_reel(spec, out_mp4, fps=30):
    total = sum(s["dur"] for s in spec["scenes"])
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", "1080x1920", "-r", str(fps), "-i", "-",
                          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", out_mp4],
                         stdin=subprocess.PIPE)
    for i in range(int(round(total * fps))):
        p.stdin.write(reel_frame(spec, i / fps).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg fallo renderizando el reel")
    return total

# ---------- Carrusel / post ----------

def render_slides(spec, out_prefix):
    outs = []
    slides = spec["slides"]
    story = spec.get("kind") == "story"
    W, H = (1080, 1920) if story else (1080, 1350)
    for i, sl in enumerate(slides, 1):
        cv = Canvas(W, H, brand=spec.get("brand", True))
        for it in laid(sl["items"], W, H):
            cv.draw(it, 1.0, 0, None)
        if len(slides) > 1 and not story:
            cv.d.text((1080 - MARGIN, 80), f"{i}/{len(slides)}", font=font(700, 30), fill=COLORS["dato"], anchor="ra")
        path = f"{out_prefix}_{i:02d}.png"
        cv.im.save(path)
        outs.append(path)
    return outs

def still(spec, t, path):
    reel_frame(spec, t).save(path)
