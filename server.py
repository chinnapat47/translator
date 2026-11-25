import os
import re
import json
import base64
import asyncio
import hashlib
import time
from collections import OrderedDict
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError
from google import genai
from google.genai import types
from google.genai import errors as genai_errors

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
# ไล่ลองโมเดลตามลำดับ ถ้าตัวไหนใช้ไม่ได้ (404) จะข้ามไปตัวถัดไปเอง
# ตั้ง GEMINI_MODEL ใน Render เพื่อบังคับให้ลองตัวที่ต้องการก่อน
MODEL_CANDIDATES = [
    m
    for m in dict.fromkeys(
        [
            os.environ.get("GEMINI_MODEL"),
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
            "gemini-3.5-flash-lite",  # เร็วและโควต้าแยก ใช้เป็นตัวสำรองสุดท้าย
        ]
    )
    if m
]
working_model: Optional[str] = None
# โมเดลที่โควต้าเต็มจะถูกพักไว้ชั่วคราว (ไม่ยิงซ้ำให้เสียเวลา): model -> (เวลาที่พักถึง, "daily"/"minute")
model_cooldown: dict = {}
DAILY_COOLDOWN_S = 1200   # โควต้ารายวัน: ลองใหม่ทุก ~20 นาที เผื่อรีเซ็ตแล้ว
MINUTE_COOLDOWN_S = 45    # โควต้าต่อนาที
# ไม่ให้เซิร์ฟเวอร์ล้มตั้งแต่ตอนเริ่มถ้าลืมตั้งค่า key (จะแจ้ง error ที่ชัดเจนตอนเรียกใช้แทน)
client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# โฟลเดอร์เก็บความจำแยกตามเรื่อง
MEMORY_DIR = Path("memory")
MEMORY_DIR.mkdir(exist_ok=True)
memory_lock = asyncio.Lock()

# แคชผลแปลตามเนื้อรูป (อ่านซ้ำหรือรีเฟรชแล้วไม่ต้องเรียก Gemini อีก ประหยัดโควต้า)
RESULT_CACHE: "OrderedDict[str, str]" = OrderedDict()
RESULT_CACHE_MAX = 300

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
SUPPORTED_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}


# --- Schema ข้อมูลเข้า/ออก ---
class TranslateRequest(BaseModel):
    series_id: str
    image_url: str = ""
    image_b64: Optional[str] = None         # รูปที่เบราว์เซอร์โหลดมาให้เอง (แก้ปัญหาเว็บบล็อกเซิร์ฟเวอร์)
    image_mime: Optional[str] = None
    prev_image_url: Optional[str] = None    # รูปก่อนหน้า (ช่วยดูหน้าตัวละครใน Manhwa)
    prev_image_b64: Optional[str] = None
    prev_image_mime: Optional[str] = None
    referer: str = ""


class SpeechBubble(BaseModel):
    box_2d: list[float]     # [ymin, xmin, ymax, xmax] สเกล 0-1000
    speaker_desc: str       # เช่น "ชายผมดำ", "หญิงชุดนักเรียน", "กล่องบรรยาย"
    pronoun_style: str      # เช่น "ฉัน/นาย", "ข้า/เจ้า", "ผม/คุณ"
    thai_text: str          # คำแปลภาษาไทย


class PageTranslation(BaseModel):
    detected_genre: Optional[str] = None   # แนวเรื่อง เช่น "Murim", "Modern Action", "Fantasy"
    new_glossary: list[str] = []           # ตัวละคร/ศัพท์ใหม่ที่เจอในหน้านี้
    bubbles: list[SpeechBubble]


# --- ฟังก์ชันจัดการความจำแยกเรื่อง ---
def get_memory_path(series_id: str) -> Path:
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", series_id)[:60] or "default"
    return MEMORY_DIR / f"{safe_id}.json"


def load_memory(series_id: str) -> dict:
    default = {"genre": "Unknown", "glossary": [], "recent_dialogues": []}
    path = get_memory_path(series_id)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {**default, **data}
        except Exception:
            return default  # ไฟล์เสีย/อ่านไม่ได้ -> เริ่มใหม่ ไม่ให้ทั้งคำขอล้ม
    return default


def save_memory(series_id: str, data: dict):
    path = get_memory_path(series_id)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# --- ฟังก์ชันจัดการรูป ---
def sniff_mime(data: bytes, fallback: str = "image/jpeg") -> str:
    """ดูชนิดไฟล์จากเนื้อไฟล์จริง (บาง CDN ส่ง content-type เป็น octet-stream)"""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "image/avif"
    return fallback


async def fetch_image(http_client: httpx.AsyncClient, url: str, referer: str):
    origin = ""
    if referer:
        p = urlparse(referer)
        if p.scheme and p.netloc:
            origin = f"{p.scheme}://{p.netloc}/"
    # ลอง Referer แบบเบราว์เซอร์จริง (origin) ก่อน แล้วค่อยลองลิงก์เต็ม
    referers = [r for r in dict.fromkeys([origin, referer]) if r] or [""]

    last_status = None
    for ref in referers:
        headers = {
            "User-Agent": BROWSER_UA,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if ref:
            headers["Referer"] = ref
        try:
            resp = await http_client.get(url, headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"โหลดรูปไม่สำเร็จ ({type(e).__name__})")
        if resp.status_code == 200 and resp.content:
            declared = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            return resp.content, sniff_mime(resp.content, declared)
        last_status = resp.status_code

    raise HTTPException(
        status_code=400,
        detail=f"โหลดรูปจากเว็บต้นทางไม่สำเร็จ (HTTP {last_status}) เว็บอาจบล็อกเซิร์ฟเวอร์",
    )


async def get_image(http_client, url, b64, mime, referer, required):
    """ใช้รูปที่เบราว์เซอร์ส่งมาก่อน ถ้าไม่มีค่อยให้เซิร์ฟเวอร์โหลดเอง"""
    if b64:
        try:
            data = base64.b64decode(b64)
        except Exception:
            if required:
                raise HTTPException(status_code=400, detail="ข้อมูลรูป (base64) ไม่ถูกต้อง")
            return None
        return data, sniff_mime(data, mime or "image/jpeg")
    if url:
        try:
            return await fetch_image(http_client, url, referer)
        except HTTPException:
            if required:
                raise
            return None
    if required:
        raise HTTPException(status_code=400, detail="ไม่ได้ส่งรูปหลักมา")
    return None


def short_name(model: str) -> str:
    return model.replace("gemini-", "")


async def call_gemini(contents):
    """เรียก Gemini แบบ async
    - 404 (โมเดลใช้ไม่ได้) -> ข้ามไปรุ่นถัดไป
    - 429 (โควต้าเต็ม; นับแยกตามโมเดล) -> พักรุ่นนั้นไว้แล้วข้ามไปรุ่นถัดไป
    - 500/503 (Gemini ไม่ว่าง) -> ลองซ้ำครั้งเดียวแล้วข้ามไปรุ่นถัดไป
    """
    global working_model
    now = time.monotonic()
    ordered = ([working_model] if working_model else []) + [
        m for m in MODEL_CANDIDATES if m != working_model
    ]
    ready = [m for m in ordered if model_cooldown.get(m, (0, ""))[0] <= now]

    if not ready:
        # ทุกรุ่นกำลังพักเพราะโควต้าเต็ม -> ตอบทันที ไม่ต้องยิง Gemini ซ้ำ
        soonest = min(model_cooldown[m][0] for m in ordered)
        kinds = {model_cooldown[m][1] for m in ordered}
        kind = "รายวัน" if kinds == {"daily"} else "ต่อนาที"
        mins = max(1, int((soonest - now) // 60) + 1)
        raise HTTPException(status_code=429, detail=f"โควต้า Gemini {kind}เต็มทุกรุ่น ลองใหม่อีกประมาณ {mins} นาที")

    delays = [1.5]
    quota_models = []   # [(model, daily?)]
    overloaded_models = []
    last_msg = ""

    for model in ready:
        use_thinking = True
        for attempt in range(len(delays) + 1):
            try:
                cfg = dict(response_mime_type="application/json", response_schema=PageTranslation)
                if model.startswith("gemini-3"):
                    # ค่าเริ่มต้นของตระกูล 3 คือคิดระดับ medium ซึ่งช้า งานอ่านแล้วแปลใช้ low พอ
                    # (LOW รองรับทุกรุ่น; MINIMAL ใช้กับ 3.7/3.8 ไม่ได้)
                    if use_thinking:
                        cfg["thinking_config"] = types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
                else:
                    cfg["temperature"] = 0.25
                response = await client.aio.models.generate_content(
                    model=model,
                    contents=contents,
                    config=types.GenerateContentConfig(**cfg),
                )
                working_model = model
                return response
            except genai_errors.APIError as e:
                code = getattr(e, "code", None)
                raw = str(e)
                last_msg = f"{short_name(model)}: {code} {getattr(e, 'message', raw)}"
                if code == 400 and use_thinking and "thinking" in raw.lower():
                    use_thinking = False  # รุ่นนี้ไม่รับ thinking_level -> ลองใหม่แบบไม่ตั้ง
                    continue
                if code == 404:
                    if model == working_model:
                        working_model = None
                    break
                if code == 429:
                    daily = "perday" in raw.lower().replace(" ", "").replace("_", "")
                    cool = DAILY_COOLDOWN_S if daily else MINUTE_COOLDOWN_S
                    model_cooldown[model] = (time.monotonic() + cool, "daily" if daily else "minute")
                    quota_models.append((model, daily))
                    break
                if code in (500, 503):
                    if attempt < len(delays):
                        await asyncio.sleep(delays[attempt])
                        continue
                    overloaded_models.append(model)
                    break
                # error อื่น (400/403 ฯลฯ) ลองซ้ำไม่ช่วย ส่ง 500 เพื่อไม่ให้ฝั่งเบราว์เซอร์ retry
                raise HTTPException(status_code=500, detail=f"Gemini error {last_msg}"[:300])

    def names(ms):
        return ", ".join(short_name(m) for m in ms)

    quota_txt = ""
    if quota_models:
        kind = "รายวัน" if all(d for _, d in quota_models) else "ต่อนาที"
        quota_txt = f"โควต้า{kind}เต็ม ({names([m for m, _ in quota_models])})"

    if overloaded_models:
        # ไม่ว่างชั่วคราว -> 503 เพื่อให้ฝั่งมือถือรอแล้วลองใหม่ (ต่างจากโควต้ารายวันที่รอไปก็ไม่หาย)
        parts = [quota_txt, f"{names(overloaded_models)} ไม่ว่างชั่วคราว"]
        raise HTTPException(status_code=503, detail=" / ".join(x for x in parts if x)[:300])
    if quota_models:
        raise HTTPException(status_code=429, detail=quota_txt[:300])
    raise HTTPException(
        status_code=500,
        detail=f"ไม่มีโมเดล Gemini ที่ใช้ได้ (ลอง {names(ready)}) ล่าสุด: {last_msg}"[:300],
    )


@app.api_route("/", methods=["GET", "HEAD"])
async def health():
    # ใช้ปลุกเซิร์ฟเวอร์ Render ที่หลับอยู่ + เช็กว่าตั้งค่า key แล้วหรือยัง
    now = time.monotonic()
    cooling = {short_name(m): f"{kind} {int(until - now)}s" for m, (until, kind) in model_cooldown.items() if until > now}
    return {
        "status": "ok",
        "gemini_key_set": client is not None,
        "model": working_model,
        "candidates": MODEL_CANDIDATES,
        "cooling_down": cooling,
    }


# รับ POST / ด้วย เผื่อ API_URL ใน userscript ลืมใส่ /translate ต่อท้าย
@app.post("/", response_model=PageTranslation, include_in_schema=False)
@app.post("/translate", response_model=PageTranslation)
async def translate_manhwa_page(req: TranslateRequest):
    if client is None:
        raise HTTPException(status_code=500, detail="เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Render")

    # 1. โหลดรูปปัจจุบัน (และรูปก่อนหน้าถ้ามี)
    async with httpx.AsyncClient(follow_redirects=True, timeout=25.0) as http_client:
        main = await get_image(http_client, req.image_url, req.image_b64, req.image_mime, req.referer, True)
        prev = await get_image(
            http_client, req.prev_image_url, req.prev_image_b64, req.prev_image_mime, req.referer, False
        )

    img_bytes, mime_type = main
    if mime_type not in SUPPORTED_MIMES:
        raise HTTPException(status_code=415, detail=f"Gemini ไม่รองรับไฟล์รูปชนิด {mime_type}")

    prev_bytes, prev_mime = prev if prev else (None, None)
    if prev_mime and prev_mime not in SUPPORTED_MIMES:
        prev_bytes = None

    cache_key = hashlib.sha1(img_bytes).hexdigest()
    cached = RESULT_CACHE.get(cache_key)
    if cached:
        RESULT_CACHE.move_to_end(cache_key)
        return PageTranslation.model_validate_json(cached)

    # 2. โหลดความจำของเรื่องนี้
    mem = load_memory(req.series_id)
    glossary_text = "\n".join(f"- {item}" for item in mem["glossary"][-40:]) or "ยังไม่มีข้อมูล"
    recent_text = "\n".join(mem["recent_dialogues"][-15:]) or "ยังไม่มีบทสนทนาก่อนหน้า"

    # 3. สร้าง Prompt พร้อมบริบท
    prompt = f"""
คุณคือนักแปล Manhwa มืออาชีพที่แปลจากภาษาอังกฤษ/ญี่ปุ่น เป็นภาษาไทยให้เป็นธรรมชาติ

[ข้อมูลเรื่องนี้]
- แนวเรื่อง (Genre): {mem['genre']}
- ตัวละครและศัพท์เฉพาะที่รู้แล้ว:
{glossary_text}

[บทสนทนาล่าสุดจากหน้าก่อนหน้า]
{recent_text}

[คำสั่ง]
1. แปลเฉพาะข้อความที่อยู่ใน "ภาพหลัก (ภาพสุดท้าย)" เท่านั้น หากมีภาพก่อนหน้าแนบมา ให้ใช้ดูหน้าตาตัวละครและบริบทต่อเนื่องเท่านั้น ห้ามดึงพิกัดจากภาพก่อนหน้า
2. ดูหางกรอบคำพูดและหน้าตาตัวละครเพื่อระบุเพศ/อารมณ์ใน `speaker_desc` และเลือกสรรพนามใน `pronoun_style` ให้เข้ากับแนวเรื่อง (เช่น แนว Murim/แฟนตาซี ใช้ ข้า/เจ้า, แนวปัจจุบันใช้ ฉัน/นาย หรือ กู/มึง ตามความสนิท)
3. แปลเป็นไทยให้ได้อารมณ์การ์ตูน กระชับ อ่านลื่นตา ไม่แปลตรงตัวทื่อๆ
4. ข้ามเสียงเอฟเฟกต์ (SFX) ขนาดใหญ่ที่เป็นส่วนหนึ่งของฉาก
5. หากเจอชื่อตัวละครใหม่หรือศัพท์เฉพาะสำคัญที่ยังไม่มีในลิสต์ ให้เพิ่มใน `new_glossary` ในรูปแบบ "ชื่อ (เพศ, บทบาท/สรรพนาม)"
6. ระบุพิกัดกรอบคำพูดใน `box_2d` แบบ [ymin, xmin, ymax, xmax] (สเกล 0-1000)
7. ให้ `box_2d` ครอบข้อความต้นฉบับทั้งหมดในกรอบคำพูดนั้นให้มิดทุกตัวอักษร แต่อย่าลามไปทับภาพวาดนอกกรอบ เพราะคำแปลจะถูกวางทับตรงกรอบนี้
8. คำแปลต้องกระชับพอใส่ลงในกรอบเดิมได้ ตัดคำฟุ่มเฟือย และไม่ต้องขึ้นบรรทัดใหม่เอง
9. ถ้าข้อความในกรอบคำพูดเดียวกันเป็นประโยคเดียวกันแต่ถูกแบ่งเป็นหลายบรรทัดหรือหลายส่วน (เช่น คำท้ายประโยคที่ตัวอักษรจางหรือเล็กกว่า) ให้รวมเป็นรายการเดียว แปลเป็นประโยคต่อเนื่อง และให้ `box_2d` ครอบทุกบรรทัดนั้น ห้ามแยกเป็นหลายรายการ
"""

    contents = []
    if prev_bytes:
        contents.append("นี่คือภาพก่อนหน้า (ใช้ดูบริบทและความต่อเนื่องเท่านั้น):")
        contents.append(types.Part.from_bytes(data=prev_bytes, mime_type=prev_mime))
    contents.append("นี่คือภาพหลักที่ต้องแปลและระบุพิกัด:")
    contents.append(types.Part.from_bytes(data=img_bytes, mime_type=mime_type))
    contents.append(prompt)

    response = await call_gemini(contents)

    text = response.text
    if not text:
        raise HTTPException(status_code=502, detail="Gemini ไม่ส่งคำตอบกลับมา (อาจถูกบล็อกโดยตัวกรองเนื้อหา)")
    try:
        result = PageTranslation.model_validate_json(text)
    except ValidationError:
        raise HTTPException(status_code=502, detail="Gemini ตอบกลับในรูปแบบที่อ่านไม่ได้ ลองใหม่อีกครั้ง")

    RESULT_CACHE[cache_key] = result.model_dump_json()
    while len(RESULT_CACHE) > RESULT_CACHE_MAX:
        RESULT_CACHE.popitem(last=False)

    # 4. อัปเดตความจำของเรื่องนี้ลงไฟล์ JSON (ล็อกกันหลายคำขอเขียนทับกัน)
    try:
        async with memory_lock:
            mem = load_memory(req.series_id)
            if result.detected_genre and mem["genre"] == "Unknown":
                mem["genre"] = result.detected_genre

            for entry in result.new_glossary:
                if entry not in mem["glossary"]:
                    mem["glossary"].append(entry)

            for b in result.bubbles:
                mem["recent_dialogues"].append(f"[{b.speaker_desc}]: {b.thai_text}")
            mem["recent_dialogues"] = mem["recent_dialogues"][-20:]  # เก็บแค่ 20 บรรทัดล่าสุด

            save_memory(req.series_id, mem)
    except Exception as e:
        # เซฟความจำพลาดไม่ควรทำให้คำแปลที่ได้มาแล้วหายไป
        print(f"memory save failed: {e}")

    return result
