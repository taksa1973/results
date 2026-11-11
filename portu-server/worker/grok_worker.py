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

Запуск: pythonw grok_worker.py (ярлык в автозагрузке Windows ставит install_startup.py).
Настройки — в worker/.env рядом: PORTU_URL, WORKER_TOKEN.
"""
import json, os, shutil, subprocess, sys, time, traceback, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = r"C:\Users\strel\yj\pw"            # короткий путь: Grok падает на длинных (MAX_PATH)
GROK = os.path.expanduser(r"~\.grok\bin\grok.exe")
LOG = os.path.join(HERE, "worker.log")
LOCK = os.path.join(WORK, "worker.lock")


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
BASE = CFG["PORTU_URL"].rstrip("/")             # https://syferpu.top/portu
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

2. image: {folder}\\portrait.png
   aspect_ratio "9:16", save to full.png
   Edit: the same cartoon character seen from a few metres away: the WHOLE body is visible from the top of the head down to the feet, standing in the lower-middle part of the frame, centred, facing the viewer, friendly calm expression, MOUTH CLOSED. The character takes about half of the frame height; pleasant softly blurred outdoor background. Same face, hair, clothes and style. No text.

3. image: {folder}\\full.png
   aspect_ratio "9:16", save to talk.png
   Edit: PHOTO EDIT, same pixel positions, do not zoom, do not move or reframe the camera, keep the character, pose, eyes, hair, clothes, background and lighting identical. The ONLY change: the mouth is open as if in the middle of saying a word. Nothing else changes.

Print DONE when portrait.png, full.png and talk.png all exist. If the tool refuses an edit, print REFUSED and the reason."""


def mouth_composite(full_path, talk_path, out_path):
    """Из кадра с открытым ртом берём только область рта — всё остальное остаётся пиксель в пиксель."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    a = Image.open(full_path).convert("RGB")
    b = Image.open(talk_path).convert("RGB").resize(a.size)
    d = np.abs(np.asarray(a, float) - np.asarray(b, float)).sum(2)
    dm = np.asarray(Image.fromarray(np.clip(d, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(10)), float)
    H, W = dm.shape
    box = np.zeros_like(dm)
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
    p = subprocess.run([GROK, "-p", PROMPT.format(photo=photo, folder=folder), "--yolo", "--max-turns", "30",
                        "--disallowed-tools", "web_search,web_fetch"],
                       cwd=folder, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1500,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    out = (p.stdout or "") + (p.stderr or "")
    have = {n: os.path.exists(os.path.join(folder, n)) for n in ("portrait.png", "full.png", "talk.png")}
    log("grok", f"{time.time() - t0:.0f} с", have, out.strip()[-300:].replace("\n", " "))
    if not have["full.png"]:
        refused = "REFUSED" in out or "moderat" in out.lower()
        final = refused or job.get("tries", 1) >= 3
        body = json.dumps({"error": out.strip()[-300:], "final": final,
                           "note": "Grok отказался рисовать по этому фото (модерация) — осталось фото." if refused
                           else "Grok не справился за три попытки — осталось фото."}).encode()
        http("POST", f"/portu/api/worker/jobs/{jid}/fail", body, "application/json")
        return
    files = {"image": ("full.png", open(os.path.join(folder, "full.png"), "rb").read(), "image/png")}
    if have["portrait.png"]:
        files["avatar"] = ("portrait.png", open(os.path.join(folder, "portrait.png"), "rb").read(), "image/png")
    if have["talk.png"]:
        try:
            if mouth_composite(os.path.join(folder, "full.png"), os.path.join(folder, "talk.png"),
                               os.path.join(folder, "talk_mix.png")):
                files["talk"] = ("talk.png", open(os.path.join(folder, "talk_mix.png"), "rb").read(), "image/png")
        except Exception:
            log("склейка рта не удалась", traceback.format_exc()[-300:])
    data, ct = multipart({}, files)
    http("POST", f"/portu/api/worker/jobs/{jid}/result", data, ct, timeout=120)
    log("готово", jid[:10], list(files))


def main():
    os.makedirs(WORK, exist_ok=True)
    # второй экземпляр не запускаем: живой процесс обновляет время замка
    if os.path.exists(LOCK) and time.time() - os.path.getmtime(LOCK) < 180:
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
