"""
Распознавание речи, ответы персонажа и озвучка.

По умолчанию всё бесплатное: Whisper и gpt-oss на Groq, голоса Microsoft
Edge (edge-tts). API Grok (xAI) включается переменными LLM_PROVIDER=xai /
STT_PROVIDER=xai, когда на console.x.ai есть баланс.
"""
import asyncio, json, re
import httpx
import edge_tts
from . import config

GROQ = "https://api.groq.com/openai/v1"
XAI = "https://api.x.ai/v1"

# Whisper на тишине и шорохе «слышит» дежурные фразы из субтитров
HALLUCINATIONS = re.compile(
    r"(legendas? pela comunidade|amara\.org|obrigad[oa] por assistir|inscreva-se|субтитры|"
    r"продолжение следует|редактор субтитров|спасибо за просмотр)", re.I)


class AIError(Exception):
    pass


# Португальский голос не читает кириллицу: «Oi, eu sou o Ярос» прозвучало бы без имени.
# Пишем русские имена так, как их прочтёт бразилец.
_RU = {'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'io', 'ж': 'j', 'з': 'z', 'и': 'i',
       'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
       'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'tch', 'ш': 'ch', 'щ': 'ch', 'ъ': '', 'ы': 'i', 'ь': '',
       'э': 'e', 'ю': 'iu', 'я': 'ia'}


def translit(text):
    def word(m):
        w = m.group(0)
        out = "".join(_RU.get(ch.lower(), ch) for ch in w)
        return out[:1].upper() + out[1:] if w[:1].isupper() else out
    return re.sub(r"[А-Яа-яЁё]+", word, text)


# ── распознавание ──────────────────────────────────────────────────────
async def transcribe(audio: bytes, filename: str, mime: str):
    """→ (text, lang), lang ∈ {'pt','ru'}; пустой text — ничего не разобрали."""
    if config.STT_PROVIDER == "xai" and config.XAI_KEY:
        return await _stt_xai(audio, filename, mime)
    return await _stt_groq(audio, filename, mime)


async def _stt_groq(audio, filename, mime, language=None):
    # Без подсказки (prompt): Whisper тянет текст на язык подсказки и «переводит»
    # русскую речь на португальский. Язык задаём только при повторе.
    data = {"model": config.STT_MODEL, "response_format": "verbose_json", "temperature": "0"}
    if language:
        data["language"] = language
    async with httpx.AsyncClient(timeout=40) as cl:
        r = await cl.post(f"{GROQ}/audio/transcriptions",
                          headers={"Authorization": f"Bearer {config.GROQ_KEY}"},
                          data=data, files={"file": (filename, audio, mime or "application/octet-stream")})
    if r.status_code != 200:
        raise AIError(f"STT {r.status_code}: {r.text[:200]}")
    j = r.json()
    text = (j.get("text") or "").strip()
    lang = (j.get("language") or "").lower()
    segs = j.get("segments") or []
    if segs and all((s.get("no_speech_prob") or 0) > 0.6 for s in segs):
        text = ""
    if HALLUCINATIONS.search(text):
        text = ""
    if not text:
        return "", "pt"
    if lang in ("russian", "ru"):
        return text, "ru"
    if lang in ("portuguese", "pt"):
        return text, "pt"
    if not language:
        # короткую фразу Whisper иногда принимает за испанский или галисийский
        return await _stt_groq(audio, filename, mime, language="pt")
    return text, "pt"


async def _stt_xai(audio, filename, mime):
    async with httpx.AsyncClient(timeout=40) as cl:
        r = await cl.post(f"{XAI}/stt", headers={"Authorization": f"Bearer {config.XAI_KEY}"},
                          files={"file": (filename, audio, mime or "application/octet-stream")})
    if r.status_code != 200:
        raise AIError(f"xAI STT {r.status_code}: {r.text[:200]}")
    j = r.json()
    text = (j.get("text") or "").strip()
    lang = (j.get("language") or "").lower()
    return text, ("ru" if lang.startswith("ru") or re.search("[а-яё]", text, re.I) else "pt")


# ── ответы персонажа ───────────────────────────────────────────────────
async def chat_json(messages, max_tokens=700):
    """Вызывает модель и возвращает разобранный JSON. Перебирает модели при 429/ошибке."""
    if config.LLM_PROVIDER == "xai" and config.XAI_KEY:
        targets = [(XAI, config.XAI_KEY, config.XAI_LLM_MODEL)]
    else:
        targets = [(GROQ, config.GROQ_KEY, m) for m in config.LLM_MODELS]
    last = None
    for url, key, model in targets:
        body = {"model": model, "messages": messages, "temperature": 0.7,
                "max_completion_tokens": max_tokens, "response_format": {"type": "json_object"}}
        if model.startswith("openai/gpt-oss"):
            body["reasoning_effort"] = "low"
        try:
            async with httpx.AsyncClient(timeout=45) as cl:
                r = await cl.post(f"{url}/chat/completions", json=body,
                                  headers={"Authorization": f"Bearer {key}"})
            if r.status_code != 200:
                last = f"{model} {r.status_code}: {r.text[:200]}"
                continue
            content = r.json()["choices"][0]["message"]["content"] or ""
            m = re.search(r"\{.*\}", content, re.S)
            if not m:
                last = f"{model}: нет JSON"
                continue
            return json.loads(m.group(0))
        except (httpx.HTTPError, json.JSONDecodeError, KeyError) as e:
            last = f"{model}: {e}"
    raise AIError(last or "модель не ответила")


def system_prompt(char_name, persona, level, topic, targets):
    words = ", ".join(f"{t.get('pt')} ({t.get('ru')})" for t in targets[:8]) or "—"
    char_name = translit(char_name)      # «Ярос» → «Iaros»: так имя прозвучит в португальской речи
    return f"""You are {char_name}, on a friendly video call with a Russian-speaking learner of Brazilian Portuguese.
Character: {persona or 'a friendly Brazilian person'}
Learner level: {level} (A1 = very simple words and present tense; A2 = simple everyday sentences; B1 = normal everyday speech; B2 = natural fluent speech).
Topic of the call: {config.TOPICS.get(topic, topic)}.
Words the learner is studying (try to use them and to make the learner use them): {words}

Rules:
1. Speak Brazilian Portuguese the way people speak in Rio de Janeiro (use "você"), warm and in character.
2. Keep every reply SHORT: 1-2 short sentences, at most about 25 words, and usually end with one simple question so the conversation continues.
3. If the learner writes or speaks in RUSSIAN (asks what you said, what a word means, says they did not understand, etc.), answer IN RUSSIAN: briefly explain what you said or meant, translate the key words, then give the simple Portuguese phrase again and invite them to answer in Portuguese. Always answer in the language the learner used.
4. If the learner makes a mistake in Portuguese, do not lecture during the call: just continue naturally, modelling the correct form. Put the correction into "tip" — the tip text itself is always in Russian (only the corrected sentence is in Portuguese). If there is no mistake, "tip" is null.
5. No emoji, no stage directions, no markdown. Inside Portuguese sentences write every name in Latin letters (never Cyrillic).

Reply with JSON only:
{{"segments": [{{"lang": "pt" or "ru", "text": "..."}}],
  "tr": "Russian translation of all Portuguese parts of your reply",
  "tip": null or "ONE short tip WRITTEN IN RUSSIAN about the learner's LAST message: what is wrong, then the corrected Portuguese sentence in quotes",
  "used": ["studied words the learner used correctly in the last message"]}}
Split the reply into segments by language: Russian text in "ru" segments, every Portuguese word or phrase in "pt" segments."""


def history_messages(turns, limit=14):
    msgs = []
    for t in turns[-limit:]:
        if t["role"] == "ai":
            msgs.append({"role": "assistant", "content": json.dumps(
                {"segments": json.loads(t["segs"] or "[]") or [{"lang": t["lang"], "text": t["text"]}]},
                ensure_ascii=False)})
        else:
            msgs.append({"role": "user", "content": t["text"]})
    return msgs


def clean_reply(j):
    segs = []
    for s in j.get("segments") or []:
        if not isinstance(s, dict):
            continue
        text = re.sub(r"\s+", " ", str(s.get("text") or "")).strip()
        if not text:
            continue
        lang = "ru" if str(s.get("lang", "")).lower().startswith("ru") else "pt"
        # модель иногда помечает русский текст как pt — проверяем по буквам
        if lang == "pt" and len(re.findall("[а-яё]", text, re.I)) > len(text) * 0.3:
            lang = "ru"
        elif lang == "pt":
            text = translit(text)       # имя или словечко кириллицей посреди португальской фразы
        if segs and segs[-1]["lang"] == lang:
            segs[-1]["text"] += " " + text
        else:
            segs.append({"lang": lang, "text": text})
    if not segs:
        segs = [{"lang": "pt", "text": "Desculpa, não entendi. Pode repetir?"}]
    tip = j.get("tip")
    tip = str(tip).strip() if tip and str(tip).strip().lower() not in ("null", "none") else None
    used = [str(u) for u in (j.get("used") or []) if isinstance(u, (str, int))][:8]
    return {"segments": segs, "tr": str(j.get("tr") or "").strip() or None, "tip": tip, "used": used}


# ── озвучка ────────────────────────────────────────────────────────────
async def _edge(text, voice, rate, pitch):
    out = bytearray()
    com = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            out += chunk["data"]
    return bytes(out)


async def speak(segments, voice_id, slow=False):
    """Озвучивает сегменты разными голосами (pt/ru) и склеивает mp3 — кадры MP3 стыкуются как есть."""
    v = config.VOICES.get(voice_id) or config.VOICES[config.DEFAULT_VOICE]
    rate = v["rate"]
    if slow:
        pct = int(rate.rstrip("%")) - 30
        rate = f"{pct:+d}%"
    parts = await asyncio.gather(*[
        _edge(s["text"], v["ru" if s["lang"] == "ru" else "pt"], rate, v["pitch"]) for s in segments])
    return b"".join(parts)
