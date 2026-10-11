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
  phone   celular flotando con una pantalla  src="assets/.../pantalla.png", w=ancho del celular, y=centro
Posiciones: x = "L" (izquierda), "C" (centro), "R" (derecha) o un numero; y en pixeles.
Tiempos (solo reel): "at" = segundo dentro de la escena en que aparece el elemento.
"""
import math, os, subprocess
from PIL import Image, ImageDraw, ImageFilter, ImageFont

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

LOGO_PATH = os.path.join(HERE, "..", "brand", "logo.png")
_logo_cache = {}
def logo(width):
    """Logo oficial (brand/logo.png). Si no esta, devuelve None y se usa el nombre en texto."""
    if not os.path.exists(LOGO_PATH):
        return None
    if width not in _logo_cache:
        im = Image.open(LOGO_PATH).convert("RGBA")
        _logo_cache[width] = im.resize((width, int(im.height * width / im.width)), Image.LANCZOS)
    return _logo_cache[width]

_phone_cache = {}
def phone_image(src, width):
    """Celular con bisel negro, esquinas redondeadas y sombra, a partir de una captura de pantalla."""
    k = (src, width)
    if k in _phone_cache:
        return _phone_cache[k]
    path = src if os.path.isabs(src) else os.path.join(HERE, "..", src)
    shot = Image.open(path).convert("RGBA")
    bezel = max(10, width // 36)
    sw = width - 2 * bezel
    sh = int(shot.height * sw / shot.width)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    r_out, r_in = width // 7, width // 7 - bezel
    m_in = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(m_in).rounded_rectangle((0, 0, sw - 1, sh - 1), r_in, fill=255)
    W, H = width, sh + 2 * bezel
    pad = 40
    out = Image.new("RGBA", (W + 2 * pad, H + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("L", out.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((pad + 6, pad + 18, pad + W + 6, pad + H + 18), r_out, fill=150)
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    out.paste((0, 0, 0, 255), (0, 0), shadow)
    body = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(body).rounded_rectangle((0, 0, W - 1, H - 1), r_out, fill=(18, 18, 20, 255), outline=(70, 70, 76, 255), width=3)
    body.paste(shot, (bezel, bezel), m_in)
    out.alpha_composite(body, (pad, pad))
    _phone_cache[k] = out
    return out

class Canvas:
    def __init__(self, w, h, brand=True, grid_offset=0.0, bg=None):
        self.w, self.h = w, h
        self.bg = bg
        if bg is not None:
            # Escena sobre video: se dibuja en una capa transparente y se compone al final
            self.im = bg
            self.layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            self.d = ImageDraw.Draw(self.layer)
        else:
            self.im = Image.new("RGB", (w, h), BG)
            self.layer = None
            self.d = ImageDraw.Draw(self.im)
            off = grid_offset % 90
            for gx in range(0, w + 90, 90):
                self.d.line([(gx - off, 0), (gx - off, h)], fill=GRID, width=1)
            for gy in range(0, h + 90, 90):
                self.d.line([(0, gy + off), (w, gy + off)], fill=GRID, width=1)
        if brand:
            by = 210 if h > 1500 else 70
            lg = logo(300 if h > 1500 else 250)
            if lg is not None:
                if self.layer is not None:
                    self.layer.alpha_composite(lg, (MARGIN, by))
                else:
                    self.im.paste(lg, (MARGIN, by), lg)
            else:
                self.d.text((MARGIN, by + 20), "AnalytiQ Core", font=font(700, 34), fill=self.paint(COLORS["dato"], 1.0))

    def paint(self, c, a):
        if self.layer is not None:
            return tuple(c[:3]) + (int(255 * clamp(a)),)
        return mix(c, a)

    def text(self, xy, txt, font, fill, anchor="la"):
        """Texto con sombra cuando va sobre video, para que se lea en cualquier escena."""
        if self.layer is not None:
            sh = (0, 0, 0, int(fill[3] * 0.75))
            for ox, oy in ((0, 4), (3, 5), (-2, 3)):
                self.d.text((xy[0] + ox, xy[1] + oy), txt, font=font, fill=sh, anchor=anchor)
        self.d.text(xy, txt, font=font, fill=fill, anchor=anchor)

    def final(self):
        if self.layer is None:
            return self.im
        out = self.im.convert("RGBA")
        out.alpha_composite(self.layer)
        return out.convert("RGB")

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
        if t == "phone":
            im = phone_image(it["src"], it.get("w", 540))
            if a < 1:
                im = im.copy(); im.putalpha(im.getchannel("A").point(lambda v: int(v * a)))
            px = (self.w - im.width) // 2 if it.get("x", "C") == "C" else int(it["x"])
            py = int(it.get("y", self.h // 2) - im.height / 2 + (1 - a) * 160)
            if self.layer is not None:
                self.layer.alpha_composite(im, (max(0, px), max(0, py)))
            else:
                self.im.paste(im, (px, py), im)
            return
        c = self.paint(col(it.get("color", "white")), a)
        if t == "text":
            f = font(it.get("w", 700), it.get("size", 60))
            pad = BOX_PAD if it.get("boxed") else 0
            maxw = it.get("maxw", self.w - 2 * MARGIN) - 2 * pad
            lh = it.get("lh", 1.18) * it.get("size", 60)
            lines = wrap(d, it["text"], f, maxw)
            if pad:
                bh = len(lines) * lh + 2 * pad - (lh - it.get("size", 60))
                d.rounded_rectangle([MARGIN, y, self.w - MARGIN, y + bh], radius=28,
                                    outline=self.paint(col(it.get("box_color", "dato")), a), width=4)
                x = self.w // 2 if h == "m" else (x + pad if h == "l" else x - pad)
                y += pad
            for i, line in enumerate(lines):
                self.text((x, y + i * lh), line, font=f, fill=c, anchor=h + "a")
        elif t == "rich":
            f = font(it.get("w", 800), it.get("size", 54))
            total = sum(d.textlength(p[0], font=f) for p in it["parts"])
            cx = x - total / 2 if h == "m" else (x - total if h == "r" else x)
            for txt, cname in it["parts"]:
                self.text((cx, y), txt, font=f, fill=self.paint(col(cname), a))
                cx += d.textlength(txt, font=f)
        elif t == "counter":
            k = ease_out(local_t / it.get("dur", 1.2)) if local_t is not None else 1.0
            v = it.get("from", 0) + (it["to"] - it.get("from", 0)) * k
            txt = clean_prefix(it) + fmt_number(v, it.get("style", "money")) + it.get("suffix", "")
            self.text((x, y), txt, font=font(it.get("w", 900), it.get("size", 120)), fill=c, anchor=h + "a")
        elif t == "pop":
            sc = ease_back(local_t / 0.6) if local_t is not None else 1.0
            self.text((x, y), it["text"], font=font(it.get("w", 900), it.get("size", 300) * max(sc, 0.05)), fill=c, anchor=h + "m")
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

def scene_at(spec, t):
    start = 0.0
    scenes = spec["scenes"]
    for si, sc in enumerate(scenes):
        if start <= t < start + sc["dur"] or si == len(scenes) - 1:
            return si, sc, t - start
        start += sc["dur"]

def reel_frame(spec, t, bg=None):
    W, H = 1080, 1920
    si, sc, lt = scene_at(spec, t)
    cv = Canvas(W, H, brand=spec.get("brand", True), grid_offset=t * 12, bg=bg)
    dur = sc["dur"]
    last = si == len(spec["scenes"]) - 1
    for it in laid(sc["items"], W, H):
        at = it.get("at", 0.0)
        a = ease_out((lt - at) / 0.35)
        if not last and not it.get("hold"):
            a *= 1 - ease_out((lt - (dur - 0.3)) / 0.3)
        dy = 0 if it["t"] in ("pop", "bar", "line", "phone") else (1 - ease_out((lt - at) / 0.35)) * 40
        cv.draw(it, a, dy, lt - at)
    im = cv.final()
    total = sum(s["dur"] for s in spec["scenes"])
    if t > total - 0.4:
        k = clamp((t - (total - 0.4)) / 0.4)
        im = Image.blend(im, Image.new("RGB", (W, H), BG), k)
    return im

class ClipReader:
    """Lee cuadros de un clip ya escalado a 1080x1920, desde un segundo dado."""
    def __init__(self, path, start, dur, fps, speed=1.0):
        # speed > 1 acelera el clip (ritmo de creador); start se mide en segundos del clip original
        vf = ("setpts=PTS/%s," % speed if speed != 1 else "") + "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=%d" % fps
        self.p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", str(start), "-i", path, "-t", str(dur * speed + 0.5),
                                   "-vf", vf,
                                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        self.last = None
    def next(self):
        buf = self.p.stdout.read(1080 * 1920 * 3)
        if len(buf) == 1080 * 1920 * 3:
            self.last = Image.frombytes("RGB", (1080, 1920), buf)
        return self.last
    def close(self):
        try: self.p.kill()
        except Exception: pass

def treat(frame, progress, scrim, zoom, punch=1.0):
    """Zoom suave + capa oscura de marca para que el texto se lea sobre el video.
    punch: zoom fijo de corte (1.15 = plano mas cerrado), el golpe de zoom tipico de creadores."""
    if zoom or punch != 1.0:
        z = punch * (1 + zoom * progress)
        w, h = int(1080 / z), int(1920 / z)
        x0, y0 = (1080 - w) // 2, (1920 - h) // 2
        frame = frame.crop((x0, y0, x0 + w, y0 + h)).resize((1080, 1920), Image.BILINEAR)
    return Image.blend(frame, Image.new("RGB", (1080, 1920), BG), scrim)

def render_reel(spec, out_mp4, fps=30, clips=None, cover=None):
    """clips: lista de rutas de video. Una escena usa {"bg": {"clip": i, "start": s}} para ir sobre el clip i."""
    clips = clips or []
    total = sum(s["dur"] for s in spec["scenes"])
    cover_at = spec.get("cover_at", 2.5)
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", "1080x1920", "-r", str(fps), "-i", "-",
                          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", out_mp4],
                         stdin=subprocess.PIPE)
    reader, cur_scene = None, None
    for i in range(int(round(total * fps))):
        t = i / fps
        si, sc, lt = scene_at(spec, t)
        bg = None
        b = sc.get("bg")
        if b is not None and b.get("clip", 0) < len(clips) and clips[b.get("clip", 0)]:
            if cur_scene != si:
                if reader: reader.close()
                reader = ClipReader(clips[b.get("clip", 0)], b.get("start", 0), sc["dur"], fps, spec.get("speed", 1.0))
                cur_scene = si
            fr = reader.next()
            if fr is not None:
                bg = treat(fr, lt / sc["dur"], b.get("scrim", 0.5), b.get("zoom", 0.06), b.get("punch", 1.0))
        im = reel_frame(spec, t, bg)
        if cover and abs(t - cover_at) < 0.5 / fps:
            im.save(cover)
        p.stdin.write(im.tobytes())
    if reader: reader.close()
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
        cv.final().save(path)
        outs.append(path)
    return outs

def still(spec, t, path):
    reel_frame(spec, t).save(path)
