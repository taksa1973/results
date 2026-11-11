#!/usr/bin/env python3
"""
Обработчик на ПК anton: делает из загруженного фото мультяшного персонажа
через Grok (подписка, CLI), без платного API.

Раз в 45 секунд спрашивает у syferpu.top/portu новые фото. На каждое — один
сеанс Grok с тремя правками:
  1. портрет: мультяшная версия человека (для кружков-аватаров), 3:4;
  2. полный рост: тот же персонаж издалека, целиком, 9:16 — для звонка;
  3. тот же кадр с открытым ртом — из него берём только область рта
     и вклеиваем в кадр 2 (иначе фон и мех чуть «плывут» при смене кадров).
Результат загружает обратно. Если Grok отказал (модерация) — сообщает, и у
персонажа остаётся обычное фото.

Где работает: на сервере serv_raboch службой portu-grok-worker (пользователь portugrok,
свой вход в Grok по коду устройства) — от ПК не зависит. Можно запустить и на ПК: python grok_worker.py.
Настройки — файл из PORTU_ENV или worker/.env рядом: PORTU_URL, WORKER_TOKEN,
необязательно PORTU_WORK (рабочая папка) и GROK_BIN (путь к grok).
"""
import json, os, shutil, subprocess, sys, time, traceback, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
WIN = os.name == "nt"


def env():
    cfg = {}
    # PORTU_ENV — другой файл настроек (например, для проверки на локальном сервере)
    for line in open(os.environ.get("PORTU_ENV") or os.path.join(HERE, ".env"), encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"')
    return cfg


CFG = env()
BASE = CFG["PORTU_URL"].rstrip("/")             # https://syferpu.top/portu или http://127.0.0.1:8095/portu
# На Windows рабочая папка — короткий путь: Grok падает на длинных (MAX_PATH)
WORK = CFG.get("PORTU_WORK") or (r"C:\Users\strel\yj\pw" if WIN else os.path.expanduser("~/portu-work"))
GROK = CFG.get("GROK_BIN") or os.path.expanduser(r"~\.grok\bin\grok.exe" if WIN else "~/.grok/bin/grok")
LOG = CFG.get("PORTU_LOG") or (os.path.join(HERE, "worker.log") if WIN else os.path.join(WORK, "worker.log"))
LOCK = os.path.join(WORK, "worker.lock")
HDR = {"x-worker-token": CFG["WORKER_TOKEN"], "User-Agent": "portu-grok-worker"}


def log(*a):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(x) for x in a)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:
        print(line, flush=True)
    except Exception:
        pass


def http(method, path, data=None, ctype=None, timeout=60):
    url = path if path.startswith("http") else BASE + path.replace("/portu", "", 1)
    req = urllib.request.Request(url, data=data, method=method, headers=dict(HDR))
    if ctype:
        req.add_header("Content-Type", ctype)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def multipart(fields, files):
    b = "----portu" + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (name, data, ct) in files.items():
        out += (f'--{b}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                f'Content-Type: {ct}\r\n\r\n').encode() + data + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={b}"


PROMPT = """Use the image_edit tool three times, one after another, and save each result to the exact file name given (in the current folder). Do not ask for confirmation.

1. image: {photo}
   aspect_ratio "3:4", save to portrait.png
   Edit: turn the person in this photo into a friendly 3D animated cartoon character (modern animated-film style). Keep them clearly recognisable: same face shape, hairstyle and hair colour, skin tone, eye colour, glasses or beard if they have them, similar clothes and colours. Head and shoulders, centred, looking at the viewer with a gentle smile, MOUTH CLOSED. Soft simple colourful background. No text.

2. image: {portrait}
   aspect_ratio "3:4", save to figure.png
   Edit: the same cartoon character (identical face, hair, skin, clothes and style), now showing the WHOLE body from the top of the head down to the shoes, standing straight, facing the viewer, arms relaxed close to the body, friendly calm expression, MOUTH CLOSED, with a small empty margin around the figure. Background: a perfectly flat pure green colour (#00FF00) from edge to edge - no floor, no shadow, no gradient, no scenery, nothing else in the frame. No text.

3. image: {figure}
   aspect_ratio "3:4", save to talk.png
   Edit: PHOTO EDIT, same pixel positions, do not zoom, do not move or reframe the camera, keep the character, pose, eyes, hair and clothes identical, and keep the background the same flat pure green. The ONLY change: the mouth is open as if in the middle of saying a word. Nothing else changes.

Print DONE when portrait.png, figure.png and talk.png all exist. If the tool refuses an edit, print REFUSED and the reason."""

# Кадр звонка собираем сами, а не просим Grok: он не держит композицию (голова упиралась
# в кнопки, фон слева оставался недорисованным). Фигуру вырезаем по зелёному и ставим на
# готовый фон 9:16 так, чтобы макушка была на 30 % высоты, а ступни — на 90 %.
BG_DIR = os.path.join(HERE, "backgrounds")
FRAME_W, FRAME_H = 720, 1280
HEAD_TOP, FIG_HEIGHT = 0.30, 0.60


def _key(img):
    """Хромакей: альфа по «зелёности» пикселя, зелёный ореол с краёв убираем."""
    import numpy as np
    a = np.asarray(img.convert("RGB"), float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    k = g - np.maximum(r, b)
    alpha = 1 - np.clip((k - 25) / 60, 0, 1)
    a[..., 1] = np.where(k > 0, np.minimum(g, np.maximum(r, b) * 1.02), g)
    return a, alpha


def compose(fig_path, talk_path, bg_path, out_full, out_talk):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    W, H = FRAME_W, FRAME_H
    bg = np.asarray(Image.open(bg_path).convert("RGB").resize((W, H), Image.LANCZOS), float)
    fig, alpha = _key(Image.open(fig_path))
    m = alpha > 0.5
    rows, cols = np.where(m.sum(1) > 3)[0], np.where(m.sum(0) > 3)[0]
    if len(rows) < 50 or len(cols) < 20:
        raise ValueError("на зелёном фоне не нашлась фигура")
    y0, y1, x0, x1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    scale = FIG_HEIGHT * H / (y1 - y0)
    if (x1 - x0) * scale > 0.92 * W:                 # руки в стороны — уменьшаем, чтобы влезло
        scale = 0.92 * W / (x1 - x0)
    fw, fh = max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale))
    top = round(HEAD_TOP * H)
    left = round(W / 2 - fw / 2)

    # мягкая тень под ногами, чтобы фигура стояла, а не висела
    shadow = Image.new("L", (W, H), 0)
    feet = top + fh
    ImageDraw.Draw(shadow).ellipse([W / 2 - fw * .32, feet - 10, W / 2 + fw * .32, feet + 12], fill=110)
    sh = np.asarray(shadow.filter(ImageFilter.GaussianBlur(9)), float)[..., None] / 255
    base = bg * (1 - sh * .45)

    def place(rgb, al):
        crop = Image.fromarray(np.clip(rgb[y0:y1, x0:x1], 0, 255).astype("uint8")).resize((fw, fh), Image.LANCZOS)
        ac = Image.fromarray(np.clip(al[y0:y1, x0:x1] * 255, 0, 255).astype("uint8")).resize((fw, fh), Image.LANCZOS)
        canvas, acanvas = np.zeros((H, W, 3)), np.zeros((H, W))
        ty0, tx0 = max(0, top), max(0, left)
        ty1, tx1 = min(H, top + fh), min(W, left + fw)
        sy0, sx0 = ty0 - top, tx0 - left
        canvas[ty0:ty1, tx0:tx1] = np.asarray(crop, float)[sy0:sy0 + ty1 - ty0, sx0:sx0 + tx1 - tx0]
        acanvas[ty0:ty1, tx0:tx1] = np.asarray(ac, float)[sy0:sy0 + ty1 - ty0, sx0:sx0 + tx1 - tx0] / 255
        acanvas = acanvas[..., None]
        return Image.fromarray(np.clip(base * (1 - acanvas) + canvas * acanvas, 0, 255).astype("uint8"))

    place(fig, alpha).save(out_full)
    # где в кадре голова — по ней ищем рот (ниже Grok иногда слегка меняет одежду)
    head = (left + fw * .2, top, left + fw * .8, top + fh * .22)
    if talk_path and os.path.exists(talk_path):
        t = Image.open(talk_path).convert("RGB")
        if t.size != Image.open(fig_path).size:
            t = t.resize(Image.open(fig_path).size, Image.LANCZOS)
        trgb, talpha = _key(t)
        place(trgb, talpha).save(out_talk)
        return head
    return None


def pick_background(char_id):
    import hashlib
    files = sorted(f for f in os.listdir(BG_DIR) if f.lower().endswith((".webp", ".png", ".jpg")))
    if not files:
        raise FileNotFoundError("нет фонов в worker/backgrounds")
    return os.path.join(BG_DIR, files[int(hashlib.md5(char_id.encode()).hexdigest(), 16) % len(files)])


def mouth_composite(full_path, talk_path, out_path, head=None):
    """Из кадра с открытым ртом берём только область рта — всё остальное остаётся пиксель в пиксель."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    a = Image.open(full_path).convert("RGB")
    b = Image.open(talk_path).convert("RGB").resize(a.size)
    d = np.abs(np.asarray(a, float) - np.asarray(b, float)).sum(2)
    dm = np.asarray(Image.fromarray(np.clip(d, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(10)), float)
    H, W = dm.shape
    box = np.zeros_like(dm)
    if head:                                   # знаем, где голова, — ищем только там
        hx0, hy0, hx1, hy1 = (int(v) for v in head)
        box[max(0, hy0):hy1, max(0, hx0):hx1] = 1
    else:
        box[int(H * .1):int(H * .65), int(W * .2):int(W * .8)] = 1   # голова в верхних двух третях: ниже Grok иногда меняет одежду
    dm *= box
    if dm.max() < 8:                       # рот не изменился — кадр с ртом бесполезен
        return False
    y, x = np.unravel_index(dm.argmax(), dm.shape)
    ys, xs = np.where(dm > dm.max() * 0.35)
    keep = (abs(ys - y) < H * .06) & (abs(xs - x) < W * .12)
    ys, xs = ys[keep], xs[keep]
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pw, ph = (x1 - x0) * .25 + 8, (y1 - y0) * .35 + 8
    m = Image.new("L", a.size, 0)
    ImageDraw.Draw(m).ellipse([x0 - pw, y0 - ph, x1 + pw, y1 + ph], fill=255)
    Image.composite(b, a, m.filter(ImageFilter.GaussianBlur(7))).save(out_path)
    return True


def process(job):
    jid = job["id"]
    folder = os.path.join(WORK, jid[:10])
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    photo = os.path.join(folder, "photo.jpg")
    open(photo, "wb").write(http("GET", job["photo"]))
    log("задание", jid[:10], job.get("name"), "попытка", job.get("tries"))
    t0 = time.time()
    prompt = PROMPT.format(photo=photo, portrait=os.path.join(folder, "portrait.png"),
                           figure=os.path.join(folder, "figure.png"))
    p = subprocess.run([GROK, "-p", prompt, "--yolo", "--max-turns", "30",
                        "--disallowed-tools", "web_search,web_fetch"],
                       cwd=folder, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1500,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    out = (p.stdout or "") + (p.stderr or "")
    have = {n: os.path.exists(os.path.join(folder, n)) for n in ("portrait.png", "figure.png", "talk.png")}
    log("grok", f"{time.time() - t0:.0f} с", have, out.strip()[-300:].replace("\n", " "))
    full, talk = os.path.join(folder, "full.png"), os.path.join(folder, "talk_full.png")
    composed, head = False, None
    if have["figure.png"]:
        try:
            bgp = pick_background(job["char_id"])
            head = compose(os.path.join(folder, "figure.png"), os.path.join(folder, "talk.png") if have["talk.png"] else None,
                           bgp, full, talk)
            composed = True
            log("собран кадр на фоне", os.path.basename(bgp))
        except Exception:
            log("сборка кадра не удалась", traceback.format_exc()[-400:])
    if not composed:
        refused = "REFUSED" in out or "moderat" in out.lower()
        final = refused or job.get("tries", 1) >= 3
        body = json.dumps({"error": out.strip()[-300:], "final": final,
                           "note": "Grok отказался рисовать по этому фото (модерация) — осталось фото." if refused
                           else "Grok не справился за три попытки — осталось фото."}).encode()
        http("POST", f"/portu/api/worker/jobs/{jid}/fail", body, "application/json")
        return
    files = {"image": ("full.png", open(full, "rb").read(), "image/png")}
    if have["portrait.png"]:
        files["avatar"] = ("portrait.png", open(os.path.join(folder, "portrait.png"), "rb").read(), "image/png")
    if os.path.exists(talk):
        try:
            if mouth_composite(full, talk, os.path.join(folder, "talk_mix.png"), head):
                files["talk"] = ("talk.png", open(os.path.join(folder, "talk_mix.png"), "rb").read(), "image/png")
        except Exception:
            log("склейка рта не удалась", traceback.format_exc()[-300:])
    data, ct = multipart({}, files)
    http("POST", f"/portu/api/worker/jobs/{jid}/result", data, ct, timeout=120)
    log("готово", jid[:10], list(files))


def other_running():
    try:
        pid = int(open(LOCK).read().strip())
    except (OSError, ValueError):
        return False
    if pid == os.getpid():
        return False
    if not WIN:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    return time.time() - os.path.getmtime(LOCK) < 180


def main():
    os.makedirs(WORK, exist_ok=True)
    # второй экземпляр не запускаем. На Linux проверяем, жив ли процесс из замка
    # (после перезапуска службы замок свежий, а процесса уже нет); на Windows — по свежести замка.
    if other_running():
        log("уже запущен — выхожу")
        return
    log("старт, сервер", BASE)
    while True:
        open(LOCK, "w").write(str(os.getpid()))
        try:
            jobs = json.loads(http("GET", "/portu/api/worker/jobs")).get("jobs", [])
            for job in jobs:
                try:
                    process(job)
                except Exception:
                    log("ошибка задания", traceback.format_exc()[-500:])
                    try:
                        http("POST", f"/portu/api/worker/jobs/{job['id']}/fail",
                             json.dumps({"error": traceback.format_exc()[-300:]}).encode(), "application/json")
                    except Exception:
                        pass
                open(LOCK, "w").write(str(os.getpid()))
        except Exception as e:
            log("сервер недоступен:", repr(e)[:200])
        if "--once" in sys.argv:
            break
        time.sleep(45)


if __name__ == "__main__":
    main()
