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
  cap     subtitulo de creadora: palabras grandes en mayusculas apiladas, entran con rebote linea a linea
          lines=[["TU HAMBURGUESA","white"],["Y TU MARCA","yellow"]], size, y=centro del bloque
Opciones de escena (reel): "brand": false oculta el logo en esa escena; "until" en un elemento lo saca antes.
Opcion de spec: "transition": "whip" = barrido rapido con desenfoque y destello entre escenas de video.
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
    "yellow": (255, 214, 10),  # acento de subtitulos de creadora
    "bg": BG,
}
GRID = (16, 57, 89)
MARGIN = 90
BOX_PAD = 40

EXTRA_FONTS = {"anton": "anton-latin-400-normal.woff", "caveat": "caveat-latin-700-normal.woff"}
_xf = {}
def xfont(name, size):
    """Fuentes de creadora: anton (condensada) y caveat (manuscrita)."""
    k = (name, max(8, int(size)))
    if k not in _xf:
        _xf[k] = ImageFont.truetype(os.path.join(HERE, "..", "fonts", EXTRA_FONTS[name]), k[1])
    return _xf[k]

_fc = {}
WEIGHTS = (500, 700, 800, 900)
def font(weight, size):
    # Solo existen estos pesos de Montserrat: cualquier otro valor se ajusta al mas cercano
    w = min(WEIGHTS, key=lambda x: abs(x - int(weight)))
    k = (w, max(8, int(size)))
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
def _local(src):
    """Ruta local de una imagen: rutas del repo, absolutas o URLs (se descargan una vez)."""
    if src.startswith("http"):
        import hashlib, tempfile, urllib.request
        dst = os.path.join(tempfile.gettempdir(), "studio_" + hashlib.sha1(src.encode()).hexdigest())
        if not os.path.exists(dst):
            urllib.request.urlretrieve(src, dst)
        return dst
    return src if os.path.isabs(src) else os.path.join(HERE, "..", src)

def phone_image(src, width, style="phone"):
    """Celular con bisel negro (style=phone) o foto con borde blanco (style=photo), con sombra."""
    k = (src, width, style)
    if k in _phone_cache:
        return _phone_cache[k]
    shot = Image.open(_local(src)).convert("RGBA")
    if style == "photo":
        shot = shot.resize((width, int(shot.height * width / shot.width)), Image.LANCZOS)
        if shot.height > width * 1.3:
            off = (shot.height - int(width * 1.3)) // 2
            shot = shot.crop((0, off, width, off + int(width * 1.3)))
        bw, r = max(8, width // 40), width // 14
        W, H = width + 2 * bw, shot.height + 2 * bw
        pad = 40
        out = Image.new("RGBA", (W + 2 * pad, H + 2 * pad), (0, 0, 0, 0))
        shadow = Image.new("L", out.size, 0)
        ImageDraw.Draw(shadow).rounded_rectangle((pad + 6, pad + 16, pad + W + 6, pad + H + 16), r, fill=140)
        out.paste((0, 0, 0, 255), (0, 0), shadow.filter(ImageFilter.GaussianBlur(20)))
        card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(card).rounded_rectangle((0, 0, W - 1, H - 1), r, fill=(255, 255, 255, 255))
        m = Image.new("L", shot.size, 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), max(4, r - bw), fill=255)
        card.paste(shot, (bw, bw), m)
        out.alpha_composite(card, (pad, pad))
        _phone_cache[k] = out
        return out
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
            im = phone_image(it["src"], it.get("w", 540), it.get("style", "phone"))
            if a < 1:
                im = im.copy(); im.putalpha(im.getchannel("A").point(lambda v: int(v * a)))
            px = (self.w - im.width) // 2 if it.get("x", "C") == "C" else int(it["x"])
            py = int(it.get("y", self.h // 2) - im.height / 2 + (1 - a) * 160)
            if self.layer is not None:
                self.layer.alpha_composite(im, (max(0, px), max(0, py)))
            else:
                self.im.paste(im, (px, py), im)
            return
        if t == "logo":
            # Logo animado: entra con rebote y queda con un leve respiro
            lt = local_t if local_t is not None else 9
            sc = max(0.05, ease_back(lt / 0.5)) * (1 + 0.015 * math.sin(lt * 3))
            lg = logo(max(10, int(it.get("w", 520) * sc)))
            if lg is None: return
            lg = lg.copy(); lg.putalpha(lg.getchannel("A").point(lambda v: int(v * clamp(a))))
            px = (self.w - lg.width) // 2; py = int(it.get("y", 700) - lg.height / 2)
            if self.layer is not None: self.layer.alpha_composite(lg, (max(0, px), max(0, py)))
            else: self.im.paste(lg, (px, py), lg)
            return
        if t == "cap":
            size = it.get("size", 96)
            lines = it["lines"]
            lh = size * 1.02
            y0 = it.get("y", 1350) - len(lines) * lh / 2
            for i, (txt, cname) in enumerate(lines):
                lt = (local_t - i * 0.12) if local_t is not None else 9
                if lt <= 0: continue
                sc = max(0.05, ease_back(lt / 0.32))
                f = xfont(it["font"], size * sc) if it.get("font") in EXTRA_FONTS else font(900, size * sc)
                fa = clamp(a * min(1.0, lt / 0.12))
                fill = self.paint(col(cname), fa)
                stroke = (0, 0, 0, int(255 * fa * 0.9)) if self.layer is not None else (0, 0, 0)
                d.text((x, y0 + i * lh + lh / 2), txt if it.get("font") == "caveat" else txt.upper(), font=f, fill=fill, anchor=h + "m",
                       stroke_width=max(2, int(size * (0.025 if it.get("font") in EXTRA_FONTS else 0.07))), stroke_fill=stroke)
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

DARK = (10, 10, 12)
_dark_bg = {}
def dark_bg(t):
    """Fondo oscuro de explicacion (estilo motion graphics): negro con puntos finos que se mueven lento."""
    k = int(t * 10) % 60
    if k not in _dark_bg:
        im = Image.new("RGB", (1080, 1920), DARK)
        d = ImageDraw.Draw(im)
        off = k * 1.5
        for gx in range(0, 1080 + 60, 60):
            for gy in range(0, 1920 + 60, 60):
                d.ellipse([gx - 1.2 + off % 60, gy - 1.2, gx + 1.2 + off % 60, gy + 1.2], fill=(38, 38, 44))
        _dark_bg[k] = im
    return _dark_bg[k].copy()

def reel_frame(spec, t, bg=None):
    W, H = 1080, 1920
    si, sc, lt = scene_at(spec, t)
    if bg is None and sc.get("dark"):
        bg = dark_bg(t)
    cv = Canvas(W, H, brand=sc.get("brand", spec.get("brand", True)), grid_offset=t * 12, bg=bg)
    dur = sc["dur"]
    last = si == len(spec["scenes"]) - 1
    for it in laid(sc["items"], W, H):
        at = it.get("at", 0.0)
        a = ease_out((lt - at) / 0.35)
        if not last and not it.get("hold"):
            a *= 1 - ease_out((lt - (dur - 0.3)) / 0.3)
        if it.get("until") is not None:
            a *= 1 - ease_out((lt - (it["until"] - 0.12)) / 0.12)
        dy = 0 if it["t"] in ("pop", "bar", "line", "phone", "cap", "logo") else (1 - ease_out((lt - at) / 0.35)) * 40
        cv.draw(it, a, dy, lt - at)
    im = cv.final()
    total = sum(s["dur"] for s in spec["scenes"])
    if t > total - 0.4:
        k = clamp((t - (total - 0.4)) / 0.4)
        im = Image.blend(im, Image.new("RGB", (W, H), DARK if spec.get("end_dark") else BG), k)
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

def treat(frame, progress, scrim, zoom, punch=1.0, tint=None):
    """Zoom suave + capa oscura de marca para que el texto se lea sobre el video.
    punch: zoom fijo de corte (1.15 = plano mas cerrado), el golpe de zoom tipico de creadores."""
    if zoom or punch != 1.0:
        z = punch * (1 + zoom * progress)
        w, h = int(1080 / z), int(1920 / z)
        x0, y0 = (1080 - w) // 2, (1920 - h) // 2
        frame = frame.crop((x0, y0, x0 + w, y0 + h)).resize((1080, 1920), Image.BILINEAR)
    return Image.blend(frame, Image.new("RGB", (1080, 1920), tint or BG), scrim)

WHIP = 0.16  # segundos de barrido a cada lado del corte

def whip(frame, k, direction):
    """Barrido horizontal con desenfoque de movimiento. k: 0 (quieto) a 1 (barrido maximo)."""
    if k <= 0.01:
        return frame
    from PIL import ImageChops
    shift = int(direction * 1080 * 0.55 * k)
    n = 6
    acc = None
    for j in range(n):
        fr = ImageChops.offset(frame, shift - int(direction * 160 * k * j / n), 0)
        acc = fr if acc is None else Image.blend(acc, fr, 1.0 / (j + 1))
    return Image.blend(acc, Image.new("RGB", acc.size, (255, 255, 255)), 0.28 * k)

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
                bg = treat(fr, lt / sc["dur"], b.get("scrim", 0.5), b.get("zoom", 0.06), b.get("punch", 1.0), DARK if spec.get("end_dark") else None)
                if spec.get("transition") == "whip":
                    scs = spec["scenes"]
                    vid = lambda j: 0 <= j < len(scs) and scs[j].get("bg") is not None
                    if lt < WHIP and vid(si - 1):
                        bg = whip(bg, 1 - lt / WHIP, 1)
                    elif sc["dur"] - lt < WHIP and vid(si + 1):
                        bg = whip(bg, 1 - (sc["dur"] - lt) / WHIP, -1)
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
