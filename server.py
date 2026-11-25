import os
import json
import re
from pathlib import Path
from typing import Optional
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

# โฟลเดอร์เก็บความจำแยกตามเรื่อง
MEMORY_DIR = Path("memory")
MEMORY_DIR.mkdir(exist_ok=True)


# --- Schema ข้อมูลเข้า/ออก ---
class TranslateRequest(BaseModel):
    series_id: str
    image_url: str
    prev_image_url: Optional[str] = None  # รูปก่อนหน้า (ช่วยดูหน้าตัวละครใน Manhwa)
    referer: str = ""


class SpeechBubble(BaseModel):
    box_2d: list[int]       # [ymin, xmin, ymax, xmax] สเกล 0-1000
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
    path = get_memory_path(series_id)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"genre": "Unknown", "glossary": [], "recent_dialogues": []}


def save_memory(series_id: str, data: dict):
    path = get_memory_path(series_id)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


async def fetch_image(http_client: httpx.AsyncClient, url: str, referer: str):
    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        "Referer": referer,
    }
    resp = await http_client.get(url, headers=headers)
    if resp.status_code != 200:
        return None, None
    mime_type = resp.headers.get("content-type", "image/jpeg").split(";")[0]
    return resp.content, mime_type


@app.post("/translate", response_model=PageTranslation)
async def translate_manhwa_page(req: TranslateRequest):
    # 1. โหลดรูปปัจจุบัน (และรูปก่อนหน้าถ้ามี)
    async with httpx.AsyncClient(follow_redirects=True, timeout=25.0) as http_client:
        img_bytes, mime_type = await fetch_image(http_client, req.image_url, req.referer)
        if not img_bytes:
            raise HTTPException(status_code=400, detail="โหลดรูปหลักไม่สำเร็จ")

        prev_bytes, prev_mime = (None, None)
        if req.prev_image_url:
            prev_bytes, prev_mime = await fetch_image(http_client, req.prev_image_url, req.referer)

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
"""

    contents = []
    if prev_bytes:
        contents.append("นี่คือภาพก่อนหน้า (ใช้ดูบริบทและความต่อเนื่องเท่านั้น):")
        contents.append(types.Part.from_bytes(data=prev_bytes, mime_type=prev_mime))
    contents.append("นี่คือภาพหลักที่ต้องแปลและระบุพิกัด:")
    contents.append(types.Part.from_bytes(data=img_bytes, mime_type=mime_type))
    contents.append(prompt)

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=PageTranslation,
                temperature=0.25,
            ),
        )
        result = PageTranslation.model_validate_json(response.text)

        # 4. อัปเดตความจำของเรื่องนี้ลงไฟล์ JSON
        if result.detected_genre and mem["genre"] == "Unknown":
            mem["genre"] = result.detected_genre

        for entry in result.new_glossary:
            if entry not in mem["glossary"]:
                mem["glossary"].append(entry)

        for b in result.bubbles:
            mem["recent_dialogues"].append(f"[{b.speaker_desc}]: {b.thai_text}")
        mem["recent_dialogues"] = mem["recent_dialogues"][-20:]  # เก็บแค่ 20 บรรทัดล่าสุด

        save_memory(req.series_id, mem)
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
