"""
Настройки сервера португальского: пути, ключи, голоса и стоковые персонажи.

Голос и персонаж выбираются независимо: у персонажа есть голос по умолчанию,
но в звонке его можно сменить на любой из VOICES.
"""
import os

BASE = "/portu"
DATA = os.environ.get("DATA_DIR", "/data")
PUBLIC = os.environ.get("PUBLIC_DIR", "/app/public")
STOCK_DIR = os.environ.get("STOCK_DIR", "/app/stock")

PEPPER = os.environ.get("PEPPER", "")            # секрет для ключа профиля из пароля
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")  # токен ПК-обработчика (Grok)

GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
XAI_KEY = os.environ.get("XAI_API_KEY", "")
# groq — бесплатно; xai — платный API Grok (включается, когда есть ключ с балансом)
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "groq")
STT_PROVIDER = os.environ.get("STT_PROVIDER", "groq")
LLM_MODELS = [m for m in os.environ.get(
    "LLM_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b").split(",") if m]
XAI_LLM_MODEL = os.environ.get("XAI_LLM_MODEL", "grok-4-fast-non-reasoning")
STT_MODEL = os.environ.get("STT_MODEL", "whisper-large-v3-turbo")

COOKIE = "portu_s"
COOKIE_AGE = 400 * 24 * 3600          # больше Chrome всё равно не держит

# ── голоса ──────────────────────────────────────────────────────────────
# pt — голос для португальского, ru — для объяснений по-русски.
# Высота и темп сдвигаются одинаково для обоих, чтобы персонаж звучал
# одним и тем же «человеком» на двух языках.
VOICES = {
    "francisca": {"label": "Франсиска", "kind": "женский",
                  "pt": "pt-BR-FranciscaNeural", "ru": "ru-RU-SvetlanaNeural",
                  "pitch": "+0Hz", "rate": "+0%"},
    "antonio":   {"label": "Антониу", "kind": "мужской",
                  "pt": "pt-BR-AntonioNeural", "ru": "ru-RU-DmitryNeural",
                  "pitch": "+0Hz", "rate": "+0%"},
    "thalita":   {"label": "Талита", "kind": "мягкий женский",
                  "pt": "pt-BR-ThalitaMultilingualNeural", "ru": "ru-RU-SvetlanaNeural",
                  "pitch": "+0Hz", "rate": "+0%"},
    "menina":    {"label": "Девочка", "kind": "детский",
                  "pt": "pt-BR-FranciscaNeural", "ru": "ru-RU-SvetlanaNeural",
                  "pitch": "+38Hz", "rate": "+6%"},
    "menino":    {"label": "Мальчик", "kind": "детский",
                  "pt": "pt-BR-ThalitaMultilingualNeural", "ru": "ru-RU-SvetlanaNeural",
                  "pitch": "+22Hz", "rate": "+8%"},
    "fofinho":   {"label": "Мультяшный писклявый", "kind": "мультик",
                  "pt": "pt-BR-FranciscaNeural", "ru": "ru-RU-SvetlanaNeural",
                  "pitch": "+85Hz", "rate": "+12%"},
    "travesso":  {"label": "Мультяшный озорной", "kind": "мультик",
                  "pt": "pt-BR-AntonioNeural", "ru": "ru-RU-DmitryNeural",
                  "pitch": "+48Hz", "rate": "+16%"},
    "vovo":      {"label": "Дедушка", "kind": "пожилой",
                  "pt": "pt-BR-AntonioNeural", "ru": "ru-RU-DmitryNeural",
                  "pitch": "-14Hz", "rate": "-10%"},
}
DEFAULT_VOICE = "francisca"

# ── стоковые персонажи ──────────────────────────────────────────────────
# Описание характера — по-португальски: так модели проще держать роль.
STOCK = [
    {"id": "peppa", "name": "Peppa", "voice": "menina",
     "persona": "Você é a Peppa Pig, uma porquinha de quatro anos, educada e um pouco mandona. "
                "Adora pular em poças de lama, fala da família (Mamãe Pig, Papai Pig e o irmãozinho "
                "George) e às vezes ri fazendo «oinc!»."},
    {"id": "stitch", "name": "Stitch", "voice": "travesso",
     "persona": "Você é o Stitch, o alienígena azul (Experimento 626). Travesso, cheio de energia e "
                "carinhoso; fala frases curtas e às vezes lembra que «ohana quer dizer família». "
                "Adora a Lilo, o Elvis e as praias do Havaí."},
    {"id": "bia", "name": "Bia", "voice": "francisca",
     "persona": "Você é a Bia (Beatriz), uma carioca de 28 anos, simpática e falante. Trabalha como designer, "
                "mora em Botafogo, adora praia, açaí, samba e viajar pelo Brasil. Conversa como uma amiga "
                "paciente, com frases simples e naturais do dia a dia."},
    {"id": "caio", "name": "Caio", "voice": "antonio",
     "persona": "Você é o Caio, um carioca de 30 anos, tranquilo e bem-humorado. Trabalha com tecnologia, "
                "mora na Tijuca, torce pelo Flamengo, joga futevôlei na praia e gosta de cozinhar. Conversa "
                "como um amigo paciente, com frases simples e naturais do dia a dia."},
    {"id": "luntik", "name": "Luntik", "voice": "menino",
     "persona": "Você é o Luntik, a criaturinha roxa e fofinha que caiu da Lua num campo de flores. "
                "Muito gentil, curioso e um pouco ingênuo; pergunta sobre tudo, adora os amigos "
                "Kuzya e Mila e a vovó Kapa, e fica feliz com coisas simples."},
]

# Готовые характеры для своих персонажей (форма «Добавить персонажа»).
# Пикачу здесь, а не в стоковых: картинку с ним Grok не рисует (модерация),
# поэтому его картинку загружают сами.
PRESETS = [
    {"id": "pikachu", "name": "Pikachu", "voice": "fofinho",
     "persona": "Você é o Pikachu, o Pokémon elétrico amarelo. Muito alegre, curioso e brincalhão; "
                "às vezes solta um «Pika!» ou «Pika-pika!» no começo ou no fim da frase. Gosta de "
                "ketchup, de aventuras com o Ash e de correr ao ar livre."},
    {"id": "amiga", "name": "Подруга", "voice": "francisca",
     "persona": "Você é uma amiga carioca simpática e paciente, que adora conversar sobre o dia a dia, "
                "comida, praia e viagens."},
    {"id": "chefe", "name": "Коллега", "voice": "antonio",
     "persona": "Você é um colega de trabalho brasileiro, educado e bem-humorado, que conversa sobre "
                "trabalho, reuniões, planos e fins de semana."},
]

LEVELS = ["A1", "A2", "B1", "B2"]

TOPICS = {
    "livre":   "conversa livre sobre o dia a dia",
    "deck":    "conversa que usa as palavras que o aluno está estudando",
    "comida":  "comida, café, restaurante e pedidos",
    "cidade":  "a cidade, transporte e como chegar a lugares",
    "familia": "família, amigos e relacionamentos",
    "trabalho": "trabalho, estudos e rotina",
    "viagem":  "viagens, férias e hotel",
    "compras": "compras, preços e lojas",
}
