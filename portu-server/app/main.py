"""
syferpu.top/portu — карточки португальского с синхронизацией по паролю и
видеозвонками с ИИ-персонажами.

Профиль = пароль. В базе лежит только HMAC пароля с секретом сервера (PEPPER),
сам пароль нигде не хранится. Устройство после входа получает долгую
httpOnly-куку и больше пароль не спрашивает.
"""
import base64, hashlib, hmac, io, json, os, re, secrets, time, uuid
from collections import defaultdict, deque

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from . import ai, config, db
from .merge import merge

B = config.BASE
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
CHAR_DIR = os.path.join(config.DATA, "chars")
os.makedirs(CHAR_DIR, exist_ok=True)


def err(status, msg):
    return JSONResponse({"error": msg}, status_code=status)


@app.middleware("http")
async def robots(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, nosnippet"
    if request.url.path.startswith(B + "/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ── ограничение попыток входа ───────────────────────────────────────────
_hits = defaultdict(deque)          # ip → времена попыток
_global = deque()
IP_LIMIT, IP_WINDOW = 10, 15 * 60
GLOBAL_LIMIT, GLOBAL_WINDOW = 120, 3600


def client_ip(req: Request):
    fwd = req.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (req.client.host if req.client else "?")


def rate_ok(ip):
    t = time.time()
    dq = _hits[ip]
    while dq and dq[0] < t - IP_WINDOW:
        dq.popleft()
    while _global and _global[0] < t - GLOBAL_WINDOW:
        _global.popleft()
    if len(dq) >= IP_LIMIT or len(_global) >= GLOBAL_LIMIT:
        return False
    dq.append(t)
    _global.append(t)
    return True


# ── профили и сессии ───────────────────────────────────────────────────
def pkey(password: str):
    return hmac.new(config.PEPPER.encode(), password.encode(), hashlib.sha256).hexdigest()


def th(token: str):
    return hashlib.sha256(token.encode()).hexdigest()


def current_user(req: Request):
    tok = req.cookies.get(config.COOKIE)
    if not tok:
        return None
    row = db.q("SELECT u.*, s.th, s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.th=?",
               (th(tok),), one=True)
    if row and db.now() - row["last_seen"] > 3600:
        db.x("UPDATE sessions SET last_seen=? WHERE th=?", (db.now(), row["th"]))
    return row


def set_cookie(resp, token):
    resp.set_cookie(config.COOKIE, token, max_age=config.COOKIE_AGE, path=B,
                    httponly=True, secure=True, samesite="lax")


def need_user(req):
    u = current_user(req)
    if not u:
        raise _Unauthorized()
    return u


class _Unauthorized(Exception):
    pass


@app.exception_handler(_Unauthorized)
async def _unauth(_req, _exc):
    return err(401, "нужен вход")


@app.exception_handler(ai.AIError)
async def _aierr(_req, exc):
    return err(502, f"ИИ не ответил: {exc}")


@app.post(B + "/api/login")
async def login(req: Request):
    body = await req.json()
    password = str(body.get("password") or "").strip()
    create = bool(body.get("create"))
    if len(password) < 4:
        return err(400, "Пароль — минимум 4 символа")
    if len(password) > 128:
        return err(400, "Слишком длинный пароль")
    if not rate_ok(client_ip(req)):
        return err(429, "Слишком много попыток. Подождите 15 минут.")
    key = pkey(password)
    user = db.q("SELECT * FROM users WHERE pkey=?", (key,), one=True)
    created = False
    if not user:
        if not create:
            return JSONResponse({"exists": False})
        uid = db.x("INSERT INTO users(pkey, created_at) VALUES(?,?)", (key, db.now()))
        user = db.q("SELECT * FROM users WHERE id=?", (uid,), one=True)
        created = True
    token = secrets.token_urlsafe(32)
    db.x("INSERT INTO sessions(th,user_id,created_at,last_seen,ua) VALUES(?,?,?,?,?)",
         (th(token), user["id"], db.now(), db.now(), (req.headers.get("user-agent") or "")[:200]))
    resp = JSONResponse({"ok": True, "user": {"id": user["id"], "level": user["level"]}, "created": created})
    set_cookie(resp, token)
    return resp


@app.post(B + "/api/logout")
async def logout(req: Request):
    tok = req.cookies.get(config.COOKIE)
    if tok:
        db.x("DELETE FROM sessions WHERE th=?", (th(tok),))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(config.COOKIE, path=B)
    return resp


@app.get(B + "/api/me")
async def me(req: Request):
    u = need_user(req)
    n = db.q("SELECT COUNT(*) c FROM sessions WHERE user_id=?", (u["id"],), one=True)["c"]
    resp = JSONResponse({"id": u["id"], "level": u["level"], "devices": n})
    set_cookie(resp, req.cookies.get(config.COOKIE))     # продлеваем срок куки
    return resp


# ── прогресс карточек ──────────────────────────────────────────────────
def load_state(uid):
    row = db.q("SELECT json, rev FROM state WHERE user_id=?", (uid,), one=True)
    return (json.loads(row["json"]), row["rev"]) if row else ({}, 0)


def store_state(uid, state, rev):
    db.x("INSERT INTO state(user_id,json,rev,updated_at) VALUES(?,?,?,?) "
         "ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, rev=excluded.rev, updated_at=excluded.updated_at",
         (uid, db.dumps(state), rev, db.now()))


@app.get(B + "/api/state")
async def get_state(req: Request):
    u = need_user(req)
    state, rev = load_state(u["id"])
    return {"state": state, "rev": rev}


@app.put(B + "/api/state")
async def put_state(req: Request):
    u = need_user(req)
    raw = await req.body()
    if len(raw) > 3_000_000:
        return err(413, "слишком большой прогресс")
    inc = json.loads(raw or b"{}")
    state, rev = load_state(u["id"])
    merged = merge(state, inc)
    store_state(u["id"], merged, rev + 1)
    out = {"rev": rev + 1}
    if req.query_params.get("full"):
        out["state"] = merged
    return out


@app.post(B + "/api/state/reset")
async def reset_state(req: Request):
    u = need_user(req)
    _, rev = load_state(u["id"])
    t = int(time.time() * 1000)
    store_state(u["id"], {"cards": {}, "log": {}, "days": [], "session": None, "sessionTs": t, "resetAt": t}, rev + 1)
    return {"rev": rev + 1, "resetAt": t}


# ── персонажи ──────────────────────────────────────────────────────────
def seed_stock():
    for i, s in enumerate(config.STOCK):
        img = os.path.join(config.STOCK_DIR, f"{s['id']}.webp")
        talk = os.path.join(config.STOCK_DIR, f"{s['id']}_talk.webp")
        av = os.path.join(config.STOCK_DIR, f"{s['id']}_av.webp")
        ex = lambda p: p if os.path.exists(p) else None
        db.x("INSERT INTO characters(id,user_id,name,kind,voice,persona,img,img_talk,img_av,status,created_at,updated_at,sort) "
             "VALUES(?,NULL,?,?,?,?,?,?,?,'ready',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, "
             "voice=excluded.voice, persona=excluded.persona, img=excluded.img, img_talk=excluded.img_talk, "
             "img_av=excluded.img_av, updated_at=excluded.updated_at, sort=excluded.sort",
             (s["id"], s["name"], "stock", s["voice"], s["persona"], ex(img), ex(talk), ex(av), db.now(),
              int(os.path.getmtime(img)) if os.path.exists(img) else db.now(), i))


seed_stock()


def char_out(c):
    v = c["updated_at"]
    return {"id": c["id"], "name": c["name"], "kind": c["kind"], "voice": c["voice"],
            "persona": c["persona"] if c["kind"] != "stock" else "",
            "img": f"{B}/api/char-img/{c['id']}?v={v}" if c["img"] else None,
            "talk": f"{B}/api/char-img/{c['id']}?kind=talk&v={v}" if c["img_talk"] else None,
            "av": f"{B}/api/char-img/{c['id']}?kind=av&v={v}" if (c["img_av"] or c["img"]) else None,
            "status": c["status"], "note": c["note"], "mine": c["user_id"] is not None}


def get_char(cid, u):
    c = db.q("SELECT * FROM characters WHERE id=?", (cid,), one=True)
    if not c or (c["user_id"] is not None and c["user_id"] != u["id"]):
        return None
    return c


@app.get(B + "/api/meta")
async def meta(req: Request):
    need_user(req)
    return {"voices": [{"id": k, "label": v["label"], "kind": v["kind"]} for k, v in config.VOICES.items()],
            "topics": list(config.TOPICS.keys()), "levels": config.LEVELS,
            "presets": config.PRESETS,
            "engine": {"llm": config.LLM_PROVIDER if config.LLM_PROVIDER != "xai" or config.XAI_KEY else "groq",
                       "stt": config.STT_PROVIDER if config.STT_PROVIDER != "xai" or config.XAI_KEY else "groq"}}


@app.get(B + "/api/characters")
async def characters(req: Request):
    u = need_user(req)
    rows = db.q("SELECT * FROM characters WHERE user_id IS NULL OR user_id=? ORDER BY user_id IS NOT NULL, sort, created_at",
                (u["id"],))
    return {"characters": [char_out(c) for c in rows]}


def portrait(im: Image.Image, w=900, h=1200):
    """Обрезает по центру до 3:4 (лицо обычно в верхней трети — сдвигаем окно вверх)."""
    im = ImageOps.exif_transpose(im).convert("RGB")
    sw, sh = im.size
    target = w / h
    if sw / sh > target:
        nw = int(sh * target)
        im = im.crop(((sw - nw) // 2, 0, (sw - nw) // 2 + nw, sh))
    else:
        nh = int(sw / target)
        top = max(0, min(sh - nh, int((sh - nh) * 0.25)))
        im = im.crop((0, top, sw, top + nh))
    return im.resize((w, h), Image.LANCZOS)


@app.post(B + "/api/characters")
async def add_character(req: Request, photo: UploadFile = File(...), name: str = Form(...),
                        voice: str = Form(config.DEFAULT_VOICE), persona: str = Form(""),
                        cartoon: str = Form("1")):
    u = need_user(req)
    mine = db.q("SELECT COUNT(*) c FROM characters WHERE user_id=?", (u["id"],), one=True)["c"]
    if mine >= 30:
        return err(400, "Больше 30 своих персонажей нельзя")
    raw = await photo.read()
    if len(raw) > 15_000_000:
        return err(413, "Фото больше 15 МБ")
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return err(400, "Это не похоже на фото: не удалось открыть файл")
    cid = "u" + uuid.uuid4().hex[:12]
    orig = os.path.join(CHAR_DIR, f"{cid}_orig.jpg")
    av = os.path.join(CHAR_DIR, f"{cid}.webp")
    full = ImageOps.exif_transpose(im).convert("RGB")
    full.thumbnail((1600, 1600))
    full.save(orig, "JPEG", quality=90)
    portrait(im).save(av, "WEBP", quality=84)
    want_cartoon = cartoon not in ("0", "false", "")
    status = "cartoon_pending" if want_cartoon else "ready"
    db.x("INSERT INTO characters(id,user_id,name,kind,voice,persona,img,img_av,status,created_at,updated_at) "
         "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
         (cid, u["id"], name.strip()[:40] or "Персонаж", "photo",
          voice if voice in config.VOICES else config.DEFAULT_VOICE, persona.strip()[:800], av, av, status,
          db.now(), db.now()))
    if want_cartoon:
        db.x("INSERT INTO jobs(id,char_id,status,created_at) VALUES(?,?, 'pending', ?)",
             (uuid.uuid4().hex, cid, db.now()))
    return {"character": char_out(db.q("SELECT * FROM characters WHERE id=?", (cid,), one=True))}


@app.patch(B + "/api/characters/{cid}")
async def edit_character(cid: str, req: Request):
    u = need_user(req)
    c = get_char(cid, u)
    if not c or c["user_id"] is None:
        return err(404, "Нет такого персонажа")
    b = await req.json()
    name = str(b.get("name", c["name"])).strip()[:40] or c["name"]
    voice = b.get("voice", c["voice"])
    voice = voice if voice in config.VOICES else c["voice"]
    persona = str(b.get("persona", c["persona"]))[:800]
    db.x("UPDATE characters SET name=?, voice=?, persona=?, updated_at=? WHERE id=?",
         (name, voice, persona, db.now(), cid))
    if b.get("recartoon"):
        db.x("UPDATE characters SET status='cartoon_pending', note=NULL WHERE id=?", (cid,))
        db.x("INSERT INTO jobs(id,char_id,status,created_at) VALUES(?,?, 'pending', ?)",
             (uuid.uuid4().hex, cid, db.now()))
    return {"character": char_out(db.q("SELECT * FROM characters WHERE id=?", (cid,), one=True))}


@app.delete(B + "/api/characters/{cid}")
async def del_character(cid: str, req: Request):
    u = need_user(req)
    c = get_char(cid, u)
    if not c or c["user_id"] is None:
        return err(404, "Нет такого персонажа")
    for suffix in ("_orig.jpg", ".webp", "_talk.webp", "_cartoon.webp", "_av.webp"):
        p = os.path.join(CHAR_DIR, cid + suffix)
        if os.path.exists(p):
            os.remove(p)
    db.x("DELETE FROM characters WHERE id=?", (cid,))
    db.x("DELETE FROM jobs WHERE char_id=?", (cid,))
    return {"ok": True}


@app.get(B + "/api/char-img/{cid}")
async def char_img(cid: str, req: Request, kind: str = ""):
    u = need_user(req)
    c = get_char(cid, u)
    p = c and ({"talk": c["img_talk"], "av": c["img_av"] or c["img"]}.get(kind) or c["img"])
    if not p or not os.path.exists(p):
        return err(404, "нет картинки")
    return FileResponse(p, media_type="image/webp",
                        headers={"Cache-Control": "private, max-age=2592000, immutable"})


# ── обработчик на ПК: делает фото мультяшным через Grok ────────────────
def need_worker(req):
    tok = req.headers.get("x-worker-token", "")
    if not config.WORKER_TOKEN or not hmac.compare_digest(tok, config.WORKER_TOKEN):
        raise _Unauthorized()


@app.get(B + "/api/worker/jobs")
async def worker_jobs(req: Request):
    need_worker(req)
    t = db.now()
    # зависшие больше 20 минут — снова в очередь
    db.x("UPDATE jobs SET status='pending' WHERE status='taken' AND taken_at < ?", (t - 1200,))
    rows = db.q("SELECT j.*, c.name FROM jobs j JOIN characters c ON c.id=j.char_id "
                "WHERE j.status='pending' ORDER BY j.created_at LIMIT 2")
    out = []
    for j in rows:
        db.x("UPDATE jobs SET status='taken', taken_at=?, tries=tries+1 WHERE id=?", (t, j["id"]))
        out.append({"id": j["id"], "char_id": j["char_id"], "name": j["name"], "tries": j["tries"] + 1,
                    "photo": f"{B}/api/worker/jobs/{j['id']}/photo"})
    return {"jobs": out}


@app.get(B + "/api/worker/jobs/{jid}/photo")
async def worker_photo(jid: str, req: Request):
    need_worker(req)
    j = db.q("SELECT * FROM jobs WHERE id=?", (jid,), one=True)
    p = j and os.path.join(CHAR_DIR, f"{j['char_id']}_orig.jpg")
    if not p or not os.path.exists(p):
        return err(404, "нет фото")
    return FileResponse(p, media_type="image/jpeg")


@app.post(B + "/api/worker/jobs/{jid}/result")
async def worker_result(jid: str, req: Request, image: UploadFile = File(...),
                        talk: UploadFile | None = File(None), avatar: UploadFile | None = File(None)):
    """image — персонаж в полный рост (9:16), talk — тот же кадр с открытым ртом, avatar — портрет."""
    need_worker(req)
    j = db.q("SELECT * FROM jobs WHERE id=?", (jid,), one=True)
    if not j:
        return err(404, "нет задания")
    cid = j["char_id"]

    def save(up, suffix, w, h):
        path = os.path.join(CHAR_DIR, cid + suffix)
        portrait(Image.open(io.BytesIO(up)), w, h).save(path, "WEBP", quality=86)
        return path
    hero = save(await image.read(), "_cartoon.webp", 720, 1280)
    talk_path = save(await talk.read(), "_talk.webp", 720, 1280) if talk is not None else None
    av_path = save(await avatar.read(), "_av.webp", 600, 800) if avatar is not None else None
    db.x("UPDATE characters SET img=?, img_talk=?, img_av=COALESCE(?, img_av), status='ready', note=NULL, "
         "updated_at=? WHERE id=?", (hero, talk_path, av_path, db.now(), cid))
    db.x("UPDATE jobs SET status='done', done_at=? WHERE id=?", (db.now(), jid))
    return {"ok": True}


@app.post(B + "/api/worker/jobs/{jid}/fail")
async def worker_fail(jid: str, req: Request):
    need_worker(req)
    b = await req.json()
    j = db.q("SELECT * FROM jobs WHERE id=?", (jid,), one=True)
    if not j:
        return err(404, "нет задания")
    final = b.get("final") or j["tries"] >= 3
    db.x("UPDATE jobs SET status=?, error=? WHERE id=?", ("failed" if final else "pending",
                                                         str(b.get("error") or "")[:300], jid))
    if final:
        db.x("UPDATE characters SET status='ready', note=?, updated_at=? WHERE id=?",
             (str(b.get("note") or "Grok не смог сделать мультяшную версию — осталось фото.")[:200],
              db.now(), j["char_id"]))
    return {"ok": True}


# ── звонки ─────────────────────────────────────────────────────────────
def call_row(cid, u):
    c = db.q("SELECT * FROM calls WHERE id=? AND user_id=?", (cid, u["id"]), one=True)
    return c


def turns_of(call_id):
    return db.q("SELECT * FROM turns WHERE call_id=? ORDER BY idx", (call_id,))


def add_turn(call_id, role, lang, text, segs=None, tr=None, tip=None):
    n = db.q("SELECT COALESCE(MAX(idx),-1)+1 n FROM turns WHERE call_id=?", (call_id,), one=True)["n"]
    db.x("INSERT INTO turns(call_id,idx,role,lang,text,segs,tr,tip,at) VALUES(?,?,?,?,?,?,?,?,?)",
         (call_id, n, role, lang, text, db.dumps(segs) if segs else None, tr, tip, db.now()))
    db.x("UPDATE calls SET turns_n=? WHERE id=?", (n + 1, call_id))
    return n


def turn_out(t):
    return {"idx": t["idx"], "role": t["role"], "lang": t["lang"], "text": t["text"],
            "segments": json.loads(t["segs"]) if t["segs"] else None, "tr": t["tr"], "tip": t["tip"]}


async def ai_reply(call, user_msg):
    char = db.q("SELECT * FROM characters WHERE id=?", (call["char_id"],), one=True)
    persona = char["persona"] if char else ""
    sys = ai.system_prompt(call["char_name"], persona, call["level"], call["topic"], json.loads(call["targets"]))
    msgs = [{"role": "system", "content": sys}] + ai.history_messages(turns_of(call["id"]))
    msgs.append({"role": "user", "content": user_msg})
    return ai.clean_reply(await ai.chat_json(msgs))


async def reply_payload(call, reply, idx):
    # озвучка не должна ронять звонок: без неё страница прочитает текст голосом браузера
    try:
        audio = base64.b64encode(await ai.speak(reply["segments"], call["voice"])).decode()
    except Exception as e:  # edge-tts ходит в сервис Microsoft, он иногда отвечает 403/таймаутом
        print("TTS не удалась:", repr(e)[:200], flush=True)
        audio = None
    return {"idx": idx, "segments": reply["segments"], "tr": reply["tr"], "audio": audio}


@app.post(B + "/api/calls")
async def start_call(req: Request):
    u = need_user(req)
    b = await req.json()
    char = get_char(str(b.get("char_id") or ""), u)
    if not char:
        return err(404, "Нет такого персонажа")
    voice = b.get("voice") if b.get("voice") in config.VOICES else char["voice"]
    topic = b.get("topic") if b.get("topic") in config.TOPICS else "livre"
    targets = [{"pt": str(t.get("pt"))[:60], "ru": str(t.get("ru"))[:80]}
               for t in (b.get("targets") or [])[:8] if isinstance(t, dict)]
    cid = uuid.uuid4().hex[:16]
    db.x("INSERT INTO calls(id,user_id,char_id,char_name,voice,topic,targets,level,started_at) "
         "VALUES(?,?,?,?,?,?,?,?,?)",
         (cid, u["id"], char["id"], char["name"], voice, topic, db.dumps(targets), u["level"], db.now()))
    call = call_row(cid, u)
    # служебная команда — по-английски: на русскую модель отвечала бы по-русски (правило 3)
    reply = await ai_reply(call, "(The call starts now. Greet the learner in Brazilian Portuguese only, introduce "
                                 "yourself in character in one short sentence and ask the first simple question "
                                 "about the topic of the call.)")
    idx = add_turn(cid, "ai", reply["segments"][0]["lang"], " ".join(s["text"] for s in reply["segments"]),
                   reply["segments"], reply["tr"])
    return {"call": {"id": cid, "voice": voice, "level": u["level"], "char": char_out(char)},
            "reply": await reply_payload(call, reply, idx)}


@app.post(B + "/api/calls/{cid}/turn")
async def call_turn(cid: str, req: Request, audio: UploadFile | None = File(None), text: str = Form("")):
    u = need_user(req)
    call = call_row(cid, u)
    if not call:
        return err(404, "Нет такого звонка")
    if call["turns_n"] > 200:
        return err(400, "Звонок слишком длинный — начните новый")
    lang = "ru" if re.search("[а-яё]", text, re.I) else "pt"
    said = text.strip()[:600]
    if audio is not None:
        raw = await audio.read()
        if len(raw) > 8_000_000:
            return err(413, "Слишком длинная запись")
        if len(raw) < 800:                      # нажали и сразу отпустили
            return {"heard": None}
        try:
            said, lang = await ai.transcribe(raw, audio.filename or "speech.webm", audio.content_type)
        except ai.AIError as e:
            if "empty" in str(e) or "too short" in str(e):
                return {"heard": None}
            raise
    if not said:
        return {"heard": None}
    uidx = add_turn(cid, "user", lang, said)
    reply = await ai_reply(call, said)
    if reply["tip"]:
        db.x("UPDATE turns SET tip=? WHERE call_id=? AND idx=?", (reply["tip"], cid, uidx))
    idx = add_turn(cid, "ai", reply["segments"][0]["lang"], " ".join(s["text"] for s in reply["segments"]),
                   reply["segments"], reply["tr"])
    return {"heard": {"text": said, "lang": lang, "idx": uidx, "used": reply["used"]},
            "reply": await reply_payload(call, reply, idx)}


@app.post(B + "/api/calls/{cid}/end")
async def end_call(cid: str, req: Request):
    u = need_user(req)
    call = call_row(cid, u)
    if not call:
        return err(404, "Нет такого звонка")
    b = await req.json()
    rating = b.get("rating") if b.get("rating") in ("easy", "ok", "hard") else None
    turns = turns_of(cid)
    title, takeaway = call["title"], call["takeaway"]
    if not title and any(t["role"] == "user" for t in turns):
        dialog = "\n".join(f"{'Персонаж' if t['role'] == 'ai' else 'Ученик'}: {t['text']}" for t in turns[-30:])
        try:
            j = await ai.chat_json([
                {"role": "system", "content":
                 "You review a Brazilian Portuguese practice call of a Russian-speaking learner. Lines marked "
                 "«Персонаж» are the AI character (a native speaker) — never criticise or correct them. Judge ONLY "
                 "the lines marked «Ученик». Reply with JSON only: "
                 '{"title": "3-5 word title of the conversation in Russian", '
                 '"takeaway": "one or two sentences in Russian: the single most useful advice for the learner based '
                 'on THEIR lines (a mistake they made, or, if there were no mistakes, how to answer more fully), '
                 'with a concrete Portuguese example in quotes"}'},
                {"role": "user", "content": dialog}], max_tokens=400)
            title = str(j.get("title") or "")[:80] or None
            takeaway = str(j.get("takeaway") or "")[:400] or None
        except ai.AIError:
            pass
    db.x("UPDATE calls SET ended_at=?, title=?, takeaway=?, rating=? WHERE id=?",
         (db.now(), title or f"Разговор с {call['char_name']}", takeaway, rating, cid))
    level = u["level"]
    if rating in ("easy", "hard"):
        i = config.LEVELS.index(level) if level in config.LEVELS else 1
        i = min(i + 1, len(config.LEVELS) - 1) if rating == "easy" else max(i - 1, 0)
        level = config.LEVELS[i]
        db.x("UPDATE users SET level=? WHERE id=?", (level, u["id"]))
    return {"title": title, "takeaway": takeaway, "level": level,
            "turns": [turn_out(t) for t in turns]}


@app.get(B + "/api/calls")
async def list_calls(req: Request):
    u = need_user(req)
    rows = db.q("SELECT * FROM calls WHERE user_id=? AND turns_n>1 ORDER BY started_at DESC LIMIT 40", (u["id"],))
    return {"calls": [{"id": c["id"], "char_id": c["char_id"], "char_name": c["char_name"],
                       "title": c["title"] or f"Разговор с {c['char_name']}", "started_at": c["started_at"],
                       "turns": c["turns_n"]} for c in rows]}


@app.get(B + "/api/calls/{cid}")
async def get_call(cid: str, req: Request):
    u = need_user(req)
    c = call_row(cid, u)
    if not c:
        return err(404, "Нет такого звонка")
    char = db.q("SELECT * FROM characters WHERE id=?", (c["char_id"],), one=True)
    return {"call": {"id": c["id"], "char_name": c["char_name"], "title": c["title"], "takeaway": c["takeaway"],
                     "started_at": c["started_at"], "voice": c["voice"],
                     "char": char_out(char) if char else None},
            "turns": [turn_out(t) for t in turns_of(cid)]}


@app.post(B + "/api/tts")
async def tts(req: Request):
    """Повтор фразы медленнее, озвучка из разбора и пробное прослушивание голоса."""
    need_user(req)
    b = await req.json()
    segs = [s for s in (b.get("segments") or []) if isinstance(s, dict) and s.get("text")][:6]
    if not segs and b.get("text"):
        segs = [{"lang": "ru" if re.search("[а-яё]", b["text"], re.I) else "pt", "text": b["text"]}]
    segs = [{"lang": "ru" if s.get("lang") == "ru" else "pt", "text": str(s["text"])[:400]} for s in segs]
    if not segs:
        return err(400, "нечего озвучивать")
    try:
        audio = await ai.speak(segs, b.get("voice") or config.DEFAULT_VOICE, slow=bool(b.get("slow")))
    except Exception as e:
        return err(502, f"Озвучка недоступна: {repr(e)[:120]}")
    return Response(audio, media_type="audio/mpeg")


# ── статика ────────────────────────────────────────────────────────────
@app.get("/portu")
async def no_slash():
    return RedirectResponse(B + "/", status_code=301)


@app.get(B + "/cartoes-pt.html")
async def old_name():
    return FileResponse(os.path.join(config.PUBLIC, "index.html"), headers={"Cache-Control": "no-cache"})


@app.get(B + "/")
async def index():
    return FileResponse(os.path.join(config.PUBLIC, "index.html"), headers={"Cache-Control": "no-cache"})


app.mount(B, StaticFiles(directory=config.PUBLIC), name="static")
