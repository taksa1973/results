"""
Слияние прогресса карточек. Та же логика продублирована в portu.js — менять
вместе.

Состояние: {cards:{id:{rep,ef,iv,due,seen,ok,miss,last,t}}, log:{день:{n,ok,t}},
days:[дни], session, sessionTs, resetAt}.

Правила:
- карточка и день журнала: побеждает запись с бо́льшим t (момент изменения);
  у старых записей t нет — тогда берём ту, где больше ответов;
- всё, что изменено не позже resetAt (кнопка «Обнулить всё»), отбрасываем;
- дни занятий — объединение, но без дней, где в журнале 0 ответов (отмена);
- незаконченная сессия — та, что изменена позже (sessionTs).
"""


def _newer(a, b, count_key):
    ta, tb = a.get("t") or 0, b.get("t") or 0
    if ta != tb:
        return ta > tb
    return (a.get(count_key) or 0) > (b.get(count_key) or 0)


def merge(base, inc):
    base = base or {}
    inc = inc or {}
    reset_at = max(base.get("resetAt") or 0, inc.get("resetAt") or 0)
    out = {"resetAt": reset_at}

    def side(name):
        return base.get(name) or {}, inc.get(name) or {}

    for name, key in (("cards", "seen"), ("log", "n")):
        a, b = side(name)
        merged = {}
        for k in set(a) | set(b):
            va, vb = a.get(k), b.get(k)
            va = va if isinstance(va, dict) else None
            vb = vb if isinstance(vb, dict) else None
            if reset_at:
                if va is not None and (va.get("t") or 0) <= reset_at:
                    va = None
                if vb is not None and (vb.get("t") or 0) <= reset_at:
                    vb = None
            if va is None and vb is None:
                continue
            if va is None:
                merged[k] = vb
            elif vb is None:
                merged[k] = va
            else:
                merged[k] = vb if _newer(vb, va, key) else va
        out[name] = merged

    days = set(base.get("days") or []) | set(inc.get("days") or [])
    log = out["log"]
    out["days"] = sorted(d for d in days if isinstance(d, str) and (log.get(d, {"n": 1}).get("n") or 0) > 0
                         and (not reset_at or d in log))

    sa, sb = base.get("sessionTs") or 0, inc.get("sessionTs") or 0
    if sb > sa:
        out["session"], out["sessionTs"] = inc.get("session"), sb
    else:
        out["session"], out["sessionTs"] = base.get("session"), sa
    if reset_at and out["sessionTs"] <= reset_at:
        out["session"] = None
    return out
